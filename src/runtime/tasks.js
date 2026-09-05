// IF Image - bounded FIFO generation task queue (Step 2.2).
// Pure runtime module: the caller injects a real executor; nothing here talks
// to backends, LLMs or the network. Executor contract: execute(task, signal)
// where `task` is an immutable snapshot and `signal` an AbortSignal.
//
// Cancellation and timeout are cooperative on the executor side: the task is
// marked terminal immediately (state never resurrects), but the physical
// concurrency slot is only released once the executor settles. An executor
// that ignores the abort signal therefore holds its slot, and the queue can
// wait forever if that executor never settles; the AbortController gives no
// guarantee that server-side processing stops.

const DEFAULT_OPTIONS = Object.freeze({
    concurrency: 2,
    maxQueued: 20,
    timeoutMs: 300000,
    historyLimit: 100,
});

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function isChatId(value) {
    return (typeof value === 'string' && value !== '')
        || (typeof value === 'number' && Number.isFinite(value));
}

export function createTaskQueue({
    execute,
    concurrency = DEFAULT_OPTIONS.concurrency,
    maxQueued = DEFAULT_OPTIONS.maxQueued,
    timeoutMs = DEFAULT_OPTIONS.timeoutMs,
    historyLimit = DEFAULT_OPTIONS.historyLimit,
    onStateChange = null,
    timers = null,
} = {}) {
    if (typeof execute !== 'function') {
        throw new TypeError('createTaskQueue: execute is required and must be a function.');
    }
    if (!isPositiveInteger(concurrency)) {
        throw new RangeError('createTaskQueue: concurrency must be a positive integer.');
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
        throw new RangeError('createTaskQueue: maxQueued must be a non-negative integer.');
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('createTaskQueue: timeoutMs must be a positive finite number.');
    }
    if (!Number.isInteger(historyLimit) || historyLimit < 0) {
        throw new RangeError('createTaskQueue: historyLimit must be a non-negative integer.');
    }
    if (onStateChange !== null && typeof onStateChange !== 'function') {
        throw new TypeError('createTaskQueue: onStateChange must be a function.');
    }
    if (timers !== null && (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function')) {
        throw new TypeError('createTaskQueue: timers must provide setTimeout and clearTimeout functions.');
    }

    const schedule = timers ? timers.setTimeout : globalThis.setTimeout.bind(globalThis);
    const cancelTimer = timers ? timers.clearTimeout : globalThis.clearTimeout.bind(globalThis);

    let disposed = false;
    let sequence = 0;
    const waiting = [];         // FIFO of admitted records with status 'queued'.
    const slots = new Set();    // Physical slots, held until the executor settles.
    const retained = new Map(); // task id -> record (live tasks plus bounded settled history).
    const history = [];         // ids of terminal records whose executor settled, oldest first.
    const pendingTimers = new Set();

    // Snapshots are defensive copies: callers (including the executor) can
    // never reach the live records through them.
    function clone(value) {
        if (Array.isArray(value)) return value.slice();
        if (value && typeof value === 'object') return { ...value };
        return value;
    }

    function snapshot(task) {
        return {
            id: task.id,
            chatId: task.chatId,
            messageId: task.messageId,
            swipeId: task.swipeId,
            revision: task.revision,
            occurrence: task.occurrence,
            prompt: clone(task.prompt),
            backend: clone(task.backend),
            profile: clone(task.profile),
            status: task.status,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            result: clone(task.result),
            error: task.error ? { ...task.error } : null,
        };
    }

    // Observers only get notified; their failures must never wedge the queue.
    function notify(task) {
        if (!onStateChange) return;
        try {
            onStateChange(snapshot(task));
        } catch (err) {
            console.error(`[IF Image] onStateChange observer failed: ${err?.message ?? err}`);
        }
    }

    function clearTaskTimer(task) {
        if (task.timeoutId === null) return;
        pendingTimers.delete(task.timeoutId);
        cancelTimer(task.timeoutId);
        task.timeoutId = null;
    }

    function finish(task, status, outcome) {
        if (TERMINAL_STATUSES.has(task.status)) return false;
        task.status = status;
        task.endedAt = Date.now();
        if (status === 'succeeded') task.result = outcome === undefined ? null : outcome;
        else task.error = outcome || { code: 'UNKNOWN', message: 'Unknown error.' };
        notify(task);
        return true;
    }

    // Only settled terminal records enter history; live ones are never pruned.
    function retire(task) {
        if (disposed) return;
        history.push(task.id);
        while (history.length > historyLimit) {
            const dropped = history.shift();
            const record = retained.get(dropped);
            if (record && TERMINAL_STATUSES.has(record.status) && record.settled) retained.delete(dropped);
        }
    }

    function onTimeout(task) {
        pendingTimers.delete(task.timeoutId);
        task.timeoutId = null;
        if (task.status !== 'running') return;
        // Cooperating executors stop here; uncooperative ones keep the slot.
        task.abortController?.abort();
        finish(task, 'failed', {
            code: 'TASK_TIMEOUT',
            message: `Task ${task.id} exceeded the running timeout of ${timeoutMs}ms.`,
        });
    }

    function start(task) {
        task.status = 'running';
        task.startedAt = Date.now();
        task.abortController = new AbortController();
        slots.add(task);
        notify(task);
        task.timeoutId = schedule(() => onTimeout(task), timeoutMs);
        pendingTimers.add(task.timeoutId);
        let execution;
        try {
            execution = execute(snapshot(task), task.abortController.signal);
        } catch (err) {
            settle(task, err);
            return;
        }
        Promise.resolve(execution).then(
            result => settle(task, null, result),
            err => settle(task, err),
        );
    }

    function settle(task, err, result) {
        if (task.settled) return;
        task.settled = true;
        clearTaskTimer(task);
        slots.delete(task);
        if (!TERMINAL_STATUSES.has(task.status)) {
            if (err) {
                const code = typeof err?.code === 'string' && err.code ? err.code : 'EXECUTOR_ERROR';
                finish(task, 'failed', { code, message: err?.message ? String(err.message) : String(err) });
            } else {
                finish(task, 'succeeded', result);
            }
        }
        // Results arriving after cancel/timeout are dropped; terminal is final.
        retire(task);
        pump();
    }

    function pump() {
        if (disposed) return;
        while (slots.size < concurrency && waiting.length > 0) {
            const task = waiting.shift();
            if (!task || task.status !== 'queued') continue;
            start(task);
        }
    }

    function markCancelled(task, code, message) {
        if (TERMINAL_STATUSES.has(task.status)) return false;
        const wasRunning = task.status === 'running';
        if (wasRunning) task.abortController?.abort();
        const changed = finish(task, 'cancelled', { code, message });
        clearTaskTimer(task);
        if (changed && !wasRunning) {
            // Queued cancel: the executor never started, nothing will settle it.
            task.settled = true;
            retire(task);
        }
        return changed;
    }

    function addTask(spec) {
        if (disposed) {
            const err = new Error('Task rejected: the queue is disposed.');
            err.code = 'QUEUE_DISPOSED';
            throw err;
        }
        if (!spec || typeof spec !== 'object') {
            throw new TypeError('addTask: the task spec must be an object.');
        }
        if (!isChatId(spec.chatId)) {
            throw new TypeError('addTask: chatId is required (non-empty string or finite number).');
        }
        if (spec.messageId !== undefined && (!Number.isInteger(spec.messageId) || spec.messageId < 0)) {
            throw new TypeError('addTask: messageId must be a non-negative integer when provided.');
        }
        const waitingCount = waiting.reduce((n, task) => n + (task.status === 'queued' ? 1 : 0), 0);
        // Capacity = concurrency + maxQueued: with a free slot the task starts
        // immediately and never waits, so maxQueued alone must not reject it.
        if (slots.size + waitingCount >= concurrency + maxQueued) {
            const err = new Error(
                `Task rejected: the queue is full (${slots.size} running, ${waitingCount}/${maxQueued} waiting).`,
            );
            err.code = 'QUEUE_FULL';
            throw err;
        }
        sequence += 1;
        const id = `task-${sequence}`;
        const task = {
            id,
            chatId: spec.chatId,
            messageId: spec.messageId ?? null,
            swipeId: spec.swipeId ?? 0,
            revision: spec.revision ?? null,
            occurrence: spec.occurrence ?? 0,
            prompt: spec.prompt ?? null,
            backend: spec.backend ?? null,
            profile: spec.profile ?? null,
            status: 'queued',
            createdAt: Date.now(),
            startedAt: null,
            endedAt: null,
            result: null,
            error: null,
            // Internal, never exposed through snapshots.
            abortController: null,
            timeoutId: null,
            settled: false,
        };
        retained.set(id, task);
        waiting.push(task);
        notify(task);
        pump();
        return id;
    }

    function getTask(id) {
        const task = retained.get(id);
        return task ? snapshot(task) : undefined;
    }

    function listTasks() {
        return Array.from(retained.values(), task => snapshot(task));
    }

    function cancelTask(id) {
        const task = retained.get(id);
        if (!task) return false;
        const changed = markCancelled(task, 'TASK_CANCELLED', `Task ${id} was cancelled.`);
        pump();
        return changed;
    }

    function cancelAllForChat(chatId) {
        if (chatId === undefined || chatId === null) return 0;
        let count = 0;
        // Mark the whole scope before draining, so no doomed task starts.
        for (const task of retained.values()) {
            if (task.chatId !== chatId) continue;
            if (markCancelled(task, 'TASK_CANCELLED', `Task ${task.id} was cancelled for chat ${chatId}.`)) count += 1;
        }
        pump();
        return count;
    }

    function cancelAll() {
        let count = 0;
        for (const task of retained.values()) {
            if (markCancelled(task, 'TASK_CANCELLED', `Task ${task.id} was cancelled.`)) count += 1;
        }
        pump();
        return count;
    }

    function dispose() {
        if (disposed) return false;
        disposed = true;
        for (const handle of pendingTimers) cancelTimer(handle);
        pendingTimers.clear();
        for (const task of retained.values()) {
            markCancelled(task, 'QUEUE_DISPOSED', 'The queue was disposed before the task completed.');
        }
        waiting.length = 0;
        retained.clear();
        history.length = 0;
        slots.clear();
        return true;
    }

    return { addTask, getTask, listTasks, cancelTask, cancelAllForChat, cancelAll, dispose };
}
