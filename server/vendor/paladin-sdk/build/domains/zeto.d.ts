import PaladinClient from "../paladin";
import { TransactionFuture } from "../transaction";
import { PaladinVerifier } from "../verifier";
export declare const algorithmZetoSnarkBJJ: (domainName: string) => string;
export declare const IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X = "iden3_pubkey_babyjubjub_compressed_0x";
export declare const zetoConstructorABI: {
    type: string;
    inputs: {
        name: string;
        type: string;
    }[];
};
export declare const zetoConstructorABI_V1: {
    type: string;
    inputs: {
        name: string;
        type: string;
    }[];
};
export interface ZetoCreateLockParams {
    from: string;
    recipients: ZetoTransfer[];
    unlockData: string;
    data: string;
}
export interface ZetoSpendLockParams {
    lockId: string;
    from: string;
    data: string;
}
export interface ZetoDelegateLockV1Params {
    lockId: string;
    delegateArgs: string;
    newSpender: string;
    data: string;
}
export interface ZetoConstructorParams {
    tokenName: string;
    domainConfigSchema?: string;
    zetoVariant?: number;
    factoryVersion?: number;
}
export interface ZetoMintParams {
    mints: ZetoTransfer[];
}
export interface ZetoTransferParams {
    transfers: ZetoTransfer[];
}
export interface ZetoLockParams {
    amount: number;
    delegate: string;
}
export interface ZetoTransferLockedParams {
    lockedInputs: string[];
    delegate: string;
    transfers: ZetoTransfer[];
}
export interface ZetoDelegateLockParams {
    utxos: string[];
    delegate: string;
}
export interface ZetoSetERC20Params {
    erc20: string;
}
export interface ZetoTransfer {
    to: PaladinVerifier;
    amount: string | number;
    data: string;
}
export interface ZetoDepositParams {
    amount: string | number;
}
export interface ZetoWithdrawParams {
    amount: string | number;
}
export interface ZetoBalanceOfParams {
    account: string;
}
export interface ZetoBalanceOfResult {
    totalBalance: string;
    totalStates: string;
    overflow: boolean;
}
export interface ZetoNonFungibleMintParams {
    mints: ZetoNonFungibleMint[];
}
export interface ZetoNonFungibleMint {
    to: PaladinVerifier;
    uri: string;
}
export interface ZetoNonFungibleTransferParams {
    transfers: ZetoNonFungibleTransfer[];
}
export interface ZetoNonFungibleTransfer {
    to: PaladinVerifier;
    tokenID: string;
}
export declare class ZetoFuture extends TransactionFuture {
    waitForDeploy(waitMs?: number): Promise<ZetoInstance | undefined>;
}
export declare class ZetoNonFungibleFuture extends TransactionFuture {
    waitForDeploy(waitMs?: number): Promise<ZetoNonFungibleInstance | undefined>;
}
export declare class ZetoFactory {
    private paladin;
    readonly domain: string;
    constructor(paladin: PaladinClient, domain: string);
    using(paladin: PaladinClient): ZetoFactory;
    newZeto(from: PaladinVerifier, data: ZetoConstructorParams): ZetoFuture;
    newZetoNonFungible(from: PaladinVerifier, data: ZetoConstructorParams): ZetoNonFungibleFuture;
}
export declare class ZetoInstance {
    private paladin;
    readonly address: string;
    private erc20?;
    constructor(paladin: PaladinClient, address: string);
    using(paladin: PaladinClient): ZetoInstance;
    mint(from: PaladinVerifier, data: ZetoMintParams): TransactionFuture;
    transfer(from: PaladinVerifier, data: ZetoTransferParams): TransactionFuture;
    transferLocked(from: PaladinVerifier, data: ZetoTransferLockedParams): TransactionFuture;
    prepareTransferLocked(from: PaladinVerifier, data: ZetoTransferLockedParams): TransactionFuture;
    lock(from: PaladinVerifier, data: ZetoLockParams): TransactionFuture;
    createLock(from: PaladinVerifier, data: ZetoCreateLockParams): TransactionFuture;
    prepareSpendLock(from: PaladinVerifier, data: ZetoSpendLockParams): TransactionFuture;
    delegateLockV1(from: PaladinVerifier, data: ZetoDelegateLockV1Params): TransactionFuture;
    delegateLock(from: PaladinVerifier, data: ZetoDelegateLockParams): TransactionFuture;
    setERC20(from: PaladinVerifier, data: ZetoSetERC20Params): TransactionFuture;
    deposit(from: PaladinVerifier, data: ZetoDepositParams): TransactionFuture;
    withdraw(from: PaladinVerifier, data: ZetoWithdrawParams): TransactionFuture;
    balanceOf(from: PaladinVerifier, data: ZetoBalanceOfParams): Promise<ZetoBalanceOfResult>;
}
export declare class ZetoNonFungibleInstance {
    private paladin;
    readonly address: string;
    constructor(paladin: PaladinClient, address: string);
    using(paladin: PaladinClient): ZetoNonFungibleInstance;
    mint(from: PaladinVerifier, data: ZetoNonFungibleMintParams): TransactionFuture;
    transfer(from: PaladinVerifier, data: ZetoNonFungibleTransferParams): TransactionFuture;
}
