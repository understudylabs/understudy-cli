import { CliError } from "../errors.js";

// Reservations cover payload bytes. Chunk storage and Buffer.concat can each
// retain one copy; parsing adds the working memory for one synchronous envelope.
export class BufferBudget {
    private available: number;
    private waiting: { bytes: number; resolve: () => void }[] = [];
    constructor(private readonly capacity: number) { this.available = capacity; }

    async run<T>(bytes: number, action: () => Promise<T>): Promise<T> {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.capacity)
            throw new CliError("Capture exceeds the available buffer allowance.");
        await new Promise<void>(resolve => {
            this.waiting.push({ bytes, resolve });
            this.drain();
        });
        try { return await action(); }
        finally { this.available += bytes; this.drain(); }
    }

    private drain() {
        while (this.waiting[0] && this.waiting[0].bytes <= this.available) {
            const next = this.waiting.shift()!;
            this.available -= next.bytes;
            next.resolve();
        }
    }
}
