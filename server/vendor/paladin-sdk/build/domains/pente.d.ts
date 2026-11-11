import { ethers } from "ethers";
import { IPrivacyGroup, IPrivacyGroupEVMCall, IPrivacyGroupEVMTXInput, IPrivacyGroupResume } from "../interfaces/privacygroups";
import PaladinClient from "../paladin";
import { TransactionFuture } from "../transaction";
import { PaladinVerifier } from "../verifier";
export interface PenteGroupTransactionInput {
    from: string;
    methodAbi: ethers.JsonFragment;
    to: string;
    data: {
        [key: string]: any;
    };
}
export interface PenteContractTransactionInput {
    from: string;
    function: string;
    data?: {
        [key: string]: any;
    };
}
export interface PenteDeploy {
    abi: ReadonlyArray<ethers.JsonFragment>;
    bytecode: string;
    from: string;
    inputs?: any;
}
export interface PentePrivacyGroupParams {
    name?: string;
    members: (string | PaladinVerifier)[];
    salt?: string;
    evmVersion?: string;
    endorsementType?: string;
    externalCallsEnabled?: boolean;
    additionalProperties?: {
        [x: string]: unknown;
    };
}
export interface PenteApproveTransitionParams {
    txId: string;
    delegate: string;
    transitionHash: string;
    signatures: string[];
}
export declare class PentePrivacyGroupFuture {
    private paladin;
    private group;
    tx: Promise<TransactionFuture | undefined>;
    constructor(paladin: PaladinClient, group: IPrivacyGroup | Promise<IPrivacyGroup>);
    waitForReceipt(waitMs?: number, full?: boolean): Promise<any>;
    waitForDeploy(waitMs?: number): Promise<PentePrivacyGroup | undefined>;
}
export declare class PenteFactory {
    private paladin;
    readonly domain: string;
    constructor(paladin: PaladinClient, domain: string);
    using(paladin: PaladinClient): PenteFactory;
    newPrivacyGroup(input: PentePrivacyGroupParams): PentePrivacyGroupFuture;
    resumePrivacyGroup(input: IPrivacyGroupResume): Promise<PentePrivacyGroup | undefined>;
}
export declare class PentePrivacyGroup {
    private paladin;
    readonly group: IPrivacyGroup;
    readonly address: string;
    readonly salt: string;
    readonly members: string[];
    constructor(paladin: PaladinClient, group: IPrivacyGroup);
    using(paladin: PaladinClient): PentePrivacyGroup;
    deploy(params: PenteDeploy, txOptions?: Partial<IPrivacyGroupEVMTXInput>): PentePrivateDeployFuture;
    sendTransaction(transaction: PenteGroupTransactionInput, txOptions?: Partial<IPrivacyGroupEVMTXInput>): TransactionFuture;
    call(transaction: PenteGroupTransactionInput, txOptions?: Partial<IPrivacyGroupEVMCall>): Promise<any>;
}
export declare class PentePrivateDeployFuture extends TransactionFuture {
    waitForDeploy(waitMs?: number): Promise<any>;
}
export declare abstract class PentePrivateContract<ConstructorParams> {
    protected evm: PentePrivacyGroup;
    protected abi: ReadonlyArray<ethers.JsonFragment>;
    readonly address: string;
    constructor(evm: PentePrivacyGroup, abi: ReadonlyArray<ethers.JsonFragment>, address: string);
    abstract using(paladin: PaladinClient): PentePrivateContract<ConstructorParams>;
    sendTransaction(transaction: PenteContractTransactionInput, txOptions?: Partial<IPrivacyGroupEVMTXInput>): TransactionFuture;
    call(transaction: PenteContractTransactionInput, txOptions?: Partial<IPrivacyGroupEVMCall>): Promise<any>;
}
