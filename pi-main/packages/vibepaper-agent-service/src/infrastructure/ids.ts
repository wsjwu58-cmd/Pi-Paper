const epoch = 1_704_067_200_000n;
const sequenceMask = 0xfffn;
const workerMask = 0x1fn;
const datacenterMask = 0x1fn;

export class SnowflakeIdGenerator {
	private lastTimestamp = -1;
	private sequence = 0n;
	private readonly nodeId: bigint;

	constructor(workerId: number, datacenterId: number) {
		if (!Number.isInteger(workerId) || workerId < 0 || workerId > 31) {
			throw new Error("SNOWFLAKE_WORKER_ID_INVALID");
		}
		if (!Number.isInteger(datacenterId) || datacenterId < 0 || datacenterId > 31) {
			throw new Error("SNOWFLAKE_DATACENTER_ID_INVALID");
		}
		this.nodeId = (BigInt(datacenterId) << 5n) | BigInt(workerId);
	}

	next(now = Date.now()): string {
		if (now < this.lastTimestamp) throw new Error("SNOWFLAKE_CLOCK_ROLLBACK");
		if (now === this.lastTimestamp) {
			this.sequence += 1n;
			if (this.sequence > sequenceMask) {
				now = this.waitForNextMillisecond();
				this.sequence = 0n;
			}
		} else {
			this.sequence = 0n;
		}
		this.lastTimestamp = now;
		const timestamp = BigInt(now) - epoch;
		return ((timestamp << 22n) | (this.nodeId << 12n) | this.sequence).toString();
	}

	private waitForNextMillisecond(): number {
		let now = Date.now();
		while (now <= this.lastTimestamp) now = Date.now();
		return now;
	}
}

const defaultGenerator = new SnowflakeIdGenerator(0, 0);

export function configureIdGenerator(workerId: number, datacenterId: number): void {
	activeGenerator = new SnowflakeIdGenerator(workerId, datacenterId);
}

let activeGenerator = defaultGenerator;

export function nextId(): string {
	return activeGenerator.next();
}

export const SNOWFLAKE_LIMITS = {
	worker: workerMask,
	datacenter: datacenterMask,
	sequence: sequenceMask,
} as const;
