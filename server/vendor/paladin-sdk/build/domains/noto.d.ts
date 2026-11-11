import { ethers } from "ethers";
import PaladinClient from "../paladin";
import { PaladinVerifier } from "../verifier";
import { TransactionFuture } from "../transaction";
export declare const notoConstructorABI: (withHooks: boolean) => ethers.JsonFragment;
export interface IGroupInfo {
    salt: string;
    members: string[];
}
export interface NotoConstructorParams {
    name?: string;
    symbol?: string;
    notary: PaladinVerifier;
    notaryMode: "basic" | "hooks";
    options?: {
        basic?: {
            restrictMint: boolean;
            allowBurn: boolean;
            allowLock: boolean;
        };
        hooks?: {
            publicAddress: string;
            privateGroup?: IGroupInfo;
            privateAddress?: string;
        };
    };
}
export interface NotoMintParams {
    to: PaladinVerifier;
    amount: string | number;
    data: string;
}
export interface NotoBurnParams {
    amount: string | number;
    data: string;
}
export interface NotoBurnFromParams {
    from: PaladinVerifier;
    amount: string | number;
    data: string;
}
export interface NotoTransferParams {
    to: PaladinVerifier;
    amount: string | number;
    data: string;
}
export interface NotoTransferFromParams {
    from: PaladinVerifier;
    to: PaladinVerifier;
    amount: string | number;
    data: string;
}
export interface NotoLockParams {
    amount: string | number;
    data: string;
}
export interface NotoCreateTransferLockParams {
    from: PaladinVerifier;
    recipients: UnlockRecipient[];
    unlockData: string;
    data: string;
}
export interface NotoCreateMintLockParams {
    recipients: UnlockRecipient[];
    unlockData: string;
    data: string;
}
export interface NotoCreateBurnLockParams {
    from: PaladinVerifier;
    amount: string | number;
    unlockData: string;
    data: string;
}
export interface NotoUnlockParams {
    lockId: string;
    from: PaladinVerifier;
    recipients: UnlockRecipient[];
    data: string;
}
export interface NotoPrepareUnlockParams {
    lockId: string;
    from: PaladinVerifier;
    recipients: UnlockRecipient[];
    unlockData: string;
    data: string;
}
export interface NotoPrepareMintUnlockParams {
    lockId: string;
    recipients: UnlockRecipient[];
    unlockData: string;
    data: string;
}
export interface NotoPrepareBurnUnlockParams {
    lockId: string;
    from: PaladinVerifier;
    amount: string | number;
    unlockData: string;
    data: string;
}
export interface UnlockRecipient {
    to: PaladinVerifier;
    amount: string | number;
}
export interface NotoDelegateLockParams {
    lockId: string;
    unlock?: NotoUnlockPublicParams;
    delegate: string;
    data: string;
}
export interface NotoUnlockPublicParams {
    txId: string;
    lockedInputs: string[];
    lockedOutputs: string[];
    outputs: string[];
    signature: string;
    data: string;
}
export interface SpendLockPublicParams {
    lockId: string;
    spendArgs: string;
    data: string;
}
export interface CancelLockPublicParams {
    lockId: string;
    cancelArgs: string;
    data: string;
}
export interface NotoBalanceOfParams {
    account: string;
}
export interface NotoBalanceOfResult {
    totalBalance: string;
    totalStates: string;
    overflow: boolean;
}
export declare class NotoFuture extends TransactionFuture {
    waitForDeploy(waitMs?: number): Promise<NotoInstance | undefined>;
}
export declare class NotoFactory {
    private paladin;
    readonly domain: string;
    constructor(paladin: PaladinClient, domain: string);
    using(paladin: PaladinClient): NotoFactory;
    newNoto(from: PaladinVerifier, data: NotoConstructorParams, idempotencyKey?: string): NotoFuture;
}
export declare class NotoInstance {
    private paladin;
    readonly address: string;
    constructor(paladin: PaladinClient, address: string);
    using(paladin: PaladinClient): NotoInstance;
    mint(from: PaladinVerifier, data: NotoMintParams, idempotencyKey?: string): TransactionFuture;
    transfer(from: PaladinVerifier, data: NotoTransferParams, idempotencyKey?: string): TransactionFuture;
    transferFrom(from: PaladinVerifier, data: NotoTransferFromParams, idempotencyKey?: string): TransactionFuture;
    burn(from: PaladinVerifier, data: NotoBurnParams, idempotencyKey?: string): TransactionFuture;
    burnFrom(from: PaladinVerifier, data: NotoBurnFromParams, idempotencyKey?: string): TransactionFuture;
    lock(from: PaladinVerifier, data: NotoLockParams, idempotencyKey?: string): TransactionFuture;
    createLock(from: PaladinVerifier, data: NotoLockParams, idempotencyKey?: string): TransactionFuture;
    createTransferLock(from: PaladinVerifier, data: NotoCreateTransferLockParams, idempotencyKey?: string): TransactionFuture;
    createMintLock(from: PaladinVerifier, data: NotoCreateMintLockParams, idempotencyKey?: string): TransactionFuture;
    createBurnLock(from: PaladinVerifier, data: NotoCreateBurnLockParams, idempotencyKey?: string): TransactionFuture;
    unlock(from: PaladinVerifier, data: NotoUnlockParams, idempotencyKey?: string): TransactionFuture;
    spendLock(from: PaladinVerifier, data: SpendLockPublicParams, idempotencyKey?: string): TransactionFuture;
    cancelLock(from: PaladinVerifier, data: CancelLockPublicParams, idempotencyKey?: string): TransactionFuture;
    prepareUnlock(from: PaladinVerifier, data: NotoPrepareUnlockParams, idempotencyKey?: string): TransactionFuture;
    prepareMintUnlock(from: PaladinVerifier, data: NotoPrepareMintUnlockParams, idempotencyKey?: string): TransactionFuture;
    prepareBurnUnlock(from: PaladinVerifier, data: NotoPrepareBurnUnlockParams, idempotencyKey?: string): TransactionFuture;
    delegateLock(from: PaladinVerifier, data: NotoDelegateLockParams, idempotencyKey?: string): TransactionFuture;
    encodeSpendLock(data: SpendLockPublicParams): string;
    encodeCancelLock(data: CancelLockPublicParams): string;
    name(from: PaladinVerifier): Promise<string>;
    symbol(from: PaladinVerifier): Promise<string>;
    decimals(from: PaladinVerifier): Promise<number>;
    balanceOf(from: PaladinVerifier, data: NotoBalanceOfParams): Promise<NotoBalanceOfResult>;
}
