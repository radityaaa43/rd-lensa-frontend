import PaladinClient from "./paladin";
export declare class TransactionFuture {
    protected paladin: PaladinClient;
    readonly id: string | Promise<string>;
    constructor(paladin: PaladinClient, id: string | Promise<string>);
    toString(): string | Promise<string>;
    waitForReceipt(waitMs?: number, full?: boolean): Promise<any>;
}
