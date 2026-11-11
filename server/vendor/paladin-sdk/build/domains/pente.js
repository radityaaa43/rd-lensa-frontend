"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PentePrivateContract = exports.PentePrivateDeployFuture = exports.PentePrivacyGroup = exports.PenteFactory = exports.PentePrivacyGroupFuture = void 0;
const transaction_1 = require("../transaction");
// Represents an in-flight Pente privacy group deployment
class PentePrivacyGroupFuture {
    constructor(paladin, group) {
        this.paladin = paladin;
        this.group = group;
        this.tx = Promise.resolve(group).then((group) => group.genesisTransaction
            ? new transaction_1.TransactionFuture(paladin, group.genesisTransaction)
            : undefined);
    }
    async waitForReceipt(waitMs, full = false) {
        const tx = await this.tx;
        return tx?.waitForReceipt(waitMs, full);
    }
    async waitForDeploy(waitMs) {
        const group = await this.group;
        const receipt = await this.waitForReceipt(waitMs);
        group.contractAddress = receipt?.contractAddress;
        return group.contractAddress
            ? new PentePrivacyGroup(this.paladin, group)
            : undefined;
    }
}
exports.PentePrivacyGroupFuture = PentePrivacyGroupFuture;
class PenteFactory {
    constructor(paladin, domain) {
        this.paladin = paladin;
        this.domain = domain;
    }
    using(paladin) {
        return new PenteFactory(paladin, this.domain);
    }
    newPrivacyGroup(input) {
        return new PentePrivacyGroupFuture(this.paladin, this.paladin.pgroup.createGroup({
            domain: this.domain,
            name: input.name,
            members: input.members.map((m) => m.toString()),
            configuration: {
                evmVersion: input.evmVersion,
                endorsementType: input.endorsementType,
                externalCallsEnabled: input.externalCallsEnabled === true
                    ? "true"
                    : input.externalCallsEnabled === false
                        ? "false"
                        : undefined,
            },
        }));
    }
    async resumePrivacyGroup(input) {
        const existingGroup = await this.paladin.pgroup.getGroupById(this.domain, input.id);
        return existingGroup?.contractAddress
            ? new PentePrivacyGroup(this.paladin, existingGroup)
            : undefined;
    }
}
exports.PenteFactory = PenteFactory;
class PentePrivacyGroup {
    constructor(paladin, group) {
        this.paladin = paladin;
        this.group = group;
        if (group.contractAddress === undefined) {
            throw new Error(`Supplied group '${group.id}' is missing a contract address. Check transaction ${group.genesisTransaction}`);
        }
        this.address = group.contractAddress;
        this.salt = group.id; // when bypassing privacy group helper functionality, and directly building Pente private transactions
        this.members = group.members;
    }
    using(paladin) {
        return new PentePrivacyGroup(paladin, this.group);
    }
    deploy(params, txOptions) {
        // Find the constructor in the ABI
        const constructor = params.abi.find((entry) => entry.type === "constructor") || { type: "constructor", inputs: [] };
        const transaction = {
            ...txOptions,
            domain: this.group.domain,
            group: this.group.id,
            from: params.from,
            input: params.inputs,
            bytecode: params.bytecode,
            function: constructor,
        };
        return new PentePrivateDeployFuture(this.paladin, this.paladin.pgroup.sendTransaction(transaction));
    }
    // sendTransaction functions in the contract (write)
    sendTransaction(transaction, txOptions) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.pgroup.sendTransaction({
            ...txOptions,
            domain: this.group.domain,
            group: this.group.id,
            from: transaction.from,
            to: transaction.to,
            input: transaction.data,
            function: transaction.methodAbi,
        }));
    }
    // call functions in the contract (read-only)
    async call(transaction, txOptions) {
        return this.paladin.pgroup.call({
            ...txOptions,
            domain: this.group.domain,
            group: this.group.id,
            from: transaction.from || "sdk.default",
            to: transaction.to,
            input: transaction.data,
            function: transaction.methodAbi,
        });
    }
}
exports.PentePrivacyGroup = PentePrivacyGroup;
// Represents an in-flight contract deployment within a privacy group
class PentePrivateDeployFuture extends transaction_1.TransactionFuture {
    async waitForDeploy(waitMs) {
        const receipt = await this.waitForReceipt(waitMs, true);
        return receipt?.domainReceipt !== undefined &&
            "receipt" in receipt.domainReceipt
            ? receipt.domainReceipt.receipt.contractAddress
            : undefined;
    }
}
exports.PentePrivateDeployFuture = PentePrivateDeployFuture;
class PentePrivateContract {
    constructor(evm, abi, address) {
        this.evm = evm;
        this.abi = abi;
        this.address = address;
    }
    sendTransaction(transaction, txOptions) {
        const method = this.abi.find((entry) => entry.name === transaction.function);
        if (method === undefined) {
            throw new Error(`Method '${transaction.function}' not found`);
        }
        return this.evm.sendTransaction({
            from: transaction.from,
            to: this.address,
            methodAbi: method,
            data: transaction.data ?? [],
        }, txOptions);
    }
    call(transaction, txOptions) {
        const method = this.abi.find((entry) => entry.name === transaction.function);
        if (method === undefined) {
            throw new Error(`Method '${transaction.function}' not found`);
        }
        return this.evm.call({
            from: transaction.from,
            to: this.address,
            methodAbi: method,
            data: transaction.data ?? [],
        }, txOptions);
    }
}
exports.PentePrivateContract = PentePrivateContract;
