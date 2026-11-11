"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importStar(require("axios"));
const verifier_1 = require("./verifier");
const POLL_INTERVAL_MS = 100;
class PaladinClient {
    constructor(options) {
        this.keymgr = {
            wallets: async () => {
                const res = await this.post("keymgr_wallets", []);
                return res.data.result;
            },
            resolveKey: async (identifier, algorithm, verifierType) => {
                const res = await this.post("keymgr_resolveKey", [identifier, algorithm, verifierType]);
                return res.data.result;
            },
            resolveEthAddress: async (identifier) => {
                const res = await this.post("keymgr_resolveEthAddress", [identifier]);
                return res.data.result;
            },
            reverseKeyLookup: async (algorithm, verifierType, verifier) => {
                const res = await this.post("keymgr_reverseKeyLookup", [algorithm, verifierType, verifier]);
                return res.data.result;
            },
            queryKeys: async (query) => {
                const res = await this.post("keymgr_queryKeys", [query]);
                return res.data.result;
            },
            sign: async (keyIdentifier, algorithm, verifierType, payloadType, payload) => {
                const res = await this.post("keymgr_sign", [keyIdentifier, algorithm, verifierType, payloadType, payload]);
                return res.data.result;
            },
        };
        this.ptx = {
            sendTransaction: async (transaction) => {
                const res = await this.post("ptx_sendTransaction", [transaction], undefined);
                return res.data.result;
            },
            sendTransactions: async (transactions) => {
                const res = await this.post("ptx_sendTransactions", [transactions], undefined);
                return res.data.result;
            },
            prepareTransaction: async (transaction) => {
                const res = await this.post("ptx_prepareTransaction", [transaction], undefined);
                return res.data.result;
            },
            prepareTransactions: async (transactions) => {
                const res = await this.post("ptx_prepareTransactions", [transactions], undefined);
                return res.data.result;
            },
            updateTransaction: async (id, transaction) => {
                const res = await this.post("ptx_updateTransaction", [id, transaction], undefined);
                return res.data.result;
            },
            call: async (transaction) => {
                const res = await this.post("ptx_call", [
                    transaction,
                ]);
                return res.data.result;
            },
            getTransaction: async (txID) => {
                const res = await this.post("ptx_getTransaction", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getTransactionFull: async (txID) => {
                const res = await this.post("ptx_getTransactionFull", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getTransactionByIdempotencyKey: async (idempotencyKey) => {
                const res = await this.post("ptx_getTransactionByIdempotencyKey", [idempotencyKey], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryTransactions: async (query) => {
                const res = await this.post("ptx_queryTransactions", [query]);
                return res.data.result;
            },
            queryTransactionsFull: async (query) => {
                const res = await this.post("ptx_queryTransactionsFull", [query]);
                return res.data.result;
            },
            queryPendingTransactions: async (query, full) => {
                const res = await this.post("ptx_queryPendingTransactions", [query, full]);
                return res.data.result;
            },
            getTransactionReceipt: async (txID) => {
                const res = await this.post("ptx_getTransactionReceipt", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getTransactionReceiptFull: async (txID) => {
                const res = await this.post("ptx_getTransactionReceiptFull", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getDomainReceipt: async (domain, txID) => {
                const res = await this.post("ptx_getDomainReceipt", [domain, txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getStateReceipt: async (txID) => {
                const res = await this.post("ptx_getStateReceipt", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryTransactionReceipts: async (query) => {
                const res = await this.post("ptx_queryTransactionReceipts", [query]);
                return res.data.result;
            },
            getTransactionDependencies: async (txID) => {
                const res = await this.post("ptx_getTransactionDependencies", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryPublicTransactions: async (query) => {
                const res = await this.post("ptx_queryPublicTransactions", [query]);
                return res.data.result;
            },
            queryPendingPublicTransactions: async (query) => {
                const res = await this.post("ptx_queryPendingPublicTransactions", [query]);
                return res.data.result;
            },
            getPublicTransactionByNonce: async (from, nonce) => {
                const res = await this.post("ptx_getPublicTransactionByNonce", [from, nonce], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getPublicTransactionByHash: async (hash) => {
                const res = await this.post("ptx_getPublicTransactionByHash", [hash], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            getPreparedTransaction: async (txID) => {
                const res = await this.post("ptx_getPreparedTransaction", [txID], {
                    validateStatus: (status) => status < 300 || status === 404,
                });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryPreparedTransactions: async (query) => {
                const res = await this.post("ptx_queryPreparedTransactions", [query]);
                return res.data.result;
            },
            storeABI: async (abi) => {
                await this.post("ptx_storeABI", [abi]);
            },
            getStoredABI: async (hash) => {
                const res = await this.post("ptx_getStoredABI", [hash]);
                return res.data.result;
            },
            queryStoredABIs: async (query) => {
                const res = await this.post("ptx_queryStoredABIs", [query]);
                return res.data.result;
            },
            decodeCall: async (callData, dataFormat) => {
                const res = await this.post("ptx_decodeCall", [callData, dataFormat]);
                return res.data.result;
            },
            decodeEvent: async (topics, data) => {
                try {
                    const res = await this.post("ptx_decodeEvent", [topics, data, ""]);
                    return res.data.result;
                }
                catch (err) {
                    const parsed = this.parseAxiosErrorMessage(err);
                    if (typeof parsed === "string" && parsed.indexOf("PD012229") >= 0) {
                        return undefined;
                    }
                    throw err;
                }
            },
            decodeError: async (revertError, dataFormat) => {
                const res = await this.post("ptx_decodeError", [revertError, dataFormat]);
                return res.data.result;
            },
            resolveVerifier: async (lookup, algorithm, verifierType) => {
                const res = await this.post("ptx_resolveVerifier", [lookup, algorithm, verifierType]);
                return res.data.result;
            },
            createReceiptListener: async (listener) => {
                const res = await this.post("ptx_createReceiptListener", [listener]);
                return res.data.result;
            },
            queryReceiptListeners: async (query) => {
                const res = await this.post("ptx_queryReceiptListeners", [query]);
                return res.data.result;
            },
            getReceiptListener: async (name) => {
                const res = await this.post("ptx_getReceiptListener", [name], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            startReceiptListener: async (name) => {
                const res = await this.post("ptx_startReceiptListener", [name]);
                return res.data.result;
            },
            stopReceiptListener: async (name) => {
                const res = await this.post("ptx_stopReceiptListener", [name]);
                return res.data.result;
            },
            deleteReceiptListener: async (name) => {
                const res = await this.post("ptx_deleteReceiptListener", [name]);
                return res.data.result;
            },
            createBlockchainEventListener: async (listener) => {
                const res = await this.post("ptx_createBlockchainEventListener", [listener]);
                return res.data.result;
            },
            queryBlockchainEventListeners: async (query) => {
                const res = await this.post("ptx_queryBlockchainEventListeners", [query]);
                return res.data.result;
            },
            getBlockchainEventListener: async (name) => {
                const res = await this.post("ptx_getBlockchainEventListener", [name], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            startBlockchainEventListener: async (name) => {
                const res = await this.post("ptx_startBlockchainEventListener", [name]);
                return res.data.result;
            },
            stopBlockchainEventListener: async (name) => {
                const res = await this.post("ptx_stopBlockchainEventListener", [name]);
                return res.data.result;
            },
            deleteBlockchainEventListener: async (name) => {
                const res = await this.post("ptx_deleteBlockchainEventListener", [name]);
                return res.data.result;
            },
            getBlockchainEventListenerStatus: async (name) => {
                const res = await this.post("ptx_getBlockchainEventListenerStatus", [name], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
        };
        this.pstate = {
            listSchemas: async (domain) => {
                const res = await this.post("pstate_listSchemas", [domain]);
                return res.data.result;
            },
            getSchemaById: async (domain, schemaId) => {
                const res = await this.post("pstate_getSchemaById", [domain, schemaId], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            storeState: async (domain, contractAddress, schema, data) => {
                const res = await this.post("pstate_storeState", [
                    domain,
                    contractAddress,
                    schema,
                    data,
                ]);
                return res.data.result;
            },
            queryStates: async (domain, schema, query, status) => {
                const res = await this.post("pstate_queryStates", [domain, schema, query, status]);
                return res.data.result;
            },
            queryContractStates: async (domain, contractAddress, schema, query, status) => {
                const res = await this.post("pstate_queryContractStates", [domain, contractAddress, schema, query, status]);
                return res.data.result;
            },
            queryNullifiers: async (domain, schema, query, status) => {
                const res = await this.post("pstate_queryNullifiers", [domain, schema, query, status]);
                return res.data.result;
            },
            queryContractNullifiers: async (domain, contractAddress, schema, query, status) => {
                const res = await this.post("pstate_queryContractNullifiers", [domain, contractAddress, schema, query, status]);
                return res.data.result;
            },
        };
        this.pgroup = {
            createGroup: async (pgroup) => {
                const res = await this.post("pgroup_createGroup", [pgroup]);
                return res.data.result;
            },
            getGroupById: async (domainName, id) => {
                const res = await this.post("pgroup_getGroupById", [domainName, id]);
                return res.data.result;
            },
            getGroupByAddress: async (address) => {
                const res = await this.post("pgroup_getGroupByAddress", [address]);
                return res.data.result;
            },
            queryGroups: async (query) => {
                const res = await this.post("pgroup_queryGroups", [query]);
                return res.data.result;
            },
            queryGroupsWithMember: async (member, query) => {
                const res = await this.post("pgroup_queryGroupsWithMember", [member, query]);
                return res.data.result;
            },
            sendTransaction: async (txi) => {
                const res = await this.post("pgroup_sendTransaction", [txi]);
                return res.data.result;
            },
            call: async (txi) => {
                const res = await this.post("pgroup_call", [txi]);
                return res.data.result;
            },
            sendMessage: async (msg) => {
                const res = await this.post("pgroup_sendMessage", [
                    msg,
                ]);
                return res.data.result;
            },
            getMessageById: async (id) => {
                const res = await this.post("pgroup_getMessageById", [id], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryMessages: async (query) => {
                const res = await this.post("pgroup_queryMessages", [query]);
                return res.data.result;
            },
            createMessageListener: async (listener) => {
                const res = await this.post("pgroup_createMessageListener", [listener]);
                return res.data.result;
            },
            queryMessageListeners: async (query) => {
                const res = await this.post("pgroup_queryMessageListeners", [query]);
                return res.data.result;
            },
            getMessageListener: async (name) => {
                const res = await this.post("pgroup_getMessageListener", [name], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            startMessageListener: async (name) => {
                const res = await this.post("pgroup_startMessageListener", [name]);
                return res.data.result;
            },
            stopMessageListener: async (name) => {
                const res = await this.post("pgroup_stopMessageListener", [name]);
                return res.data.result;
            },
            deleteMessageListener: async (name) => {
                const res = await this.post("pgroup_deleteMessageListener", [name]);
                return res.data.result;
            },
            invokeRPC: async (domainName, groupID, stateQualifier, rpcCall) => {
                const res = await this.post("pgroup_invokeRPC", [domainName, groupID, stateQualifier, rpcCall]);
                return res.data.result;
            },
        };
        this.transport = {
            nodeName: async () => {
                const res = await this.post("transport_nodeName", []);
                return res.data.result;
            },
            localTransports: async () => {
                const res = await this.post("transport_localTransports", []);
                return res.data.result;
            },
            localTransportDetails: async (transportName) => {
                const res = await this.post("transport_localTransportDetails", [transportName]);
                return res.data.result;
            },
            /**
             * @deprecated Use transport.queryPeers instead
             */
            peers: async () => {
                const res = await this.post("transport_peers", []);
                return res.data.result;
            },
            queryPeers: async (query) => {
                const res = await this.post("transport_queryPeers", [query]);
                return res.data.result;
            },
            /**
           * @deprecated Use transport.getPeer instead
           */
            peerInfo: async (nodeName) => {
                const res = await this.post("transport_peerInfo", [nodeName], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            getPeer: async (nodeName) => {
                const res = await this.post("transport_getPeer", [nodeName], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            queryReliableMessages: async (query) => {
                const res = await this.post("transport_queryReliableMessages", [query]);
                return res.data.result;
            },
            queryReliableMessageAcks: async (query) => {
                const res = await this.post("transport_queryReliableMessageAcks", [query]);
                return res.data.result;
            },
        };
        this.domain = {
            listDomains: async () => {
                const res = await this.post("domain_listDomains", []);
                return res.data.result;
            },
            getDomain: async (name) => {
                const res = await this.post("domain_getDomain", [name], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            getDomainByAddress: async (address) => {
                const res = await this.post("domain_getDomainByAddress", [address], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            querySmartContracts: async (query) => {
                const res = await this.post("domain_querySmartContracts", [query]);
                return res.data.result;
            },
            getSmartContractByAddress: async (address) => {
                const res = await this.post("domain_getSmartContractByAddress", [address], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            invokeRPC: async (contractAddress, stateQualifier, rpcCall) => {
                const res = await this.post("domain_invokeRPC", [contractAddress, stateQualifier, rpcCall]);
                return res.data.result;
            },
        };
        this.bidx = {
            getBlockByNumber: async (number) => {
                const res = await this.post("bidx_getBlockByNumber", [number], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            getTransactionByHash: async (hash) => {
                const res = await this.post("bidx_getTransactionByHash", [hash], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            getTransactionByNonce: async (from, nonce) => {
                const res = await this.post("bidx_getTransactionByNonce", [from, nonce], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
            getBlockTransactionsByNumber: async (blockNumber) => {
                const res = await this.post("bidx_getBlockTransactionsByNumber", [blockNumber]);
                return res.data.result;
            },
            getTransactionEventsByHash: async (hash) => {
                const res = await this.post("bidx_getTransactionEventsByHash", [hash]);
                return res.data.result;
            },
            queryIndexedBlocks: async (query) => {
                const res = await this.post("bidx_queryIndexedBlocks", [query]);
                return res.data.result;
            },
            queryIndexedTransactions: async (query) => {
                const res = await this.post("bidx_queryIndexedTransactions", [query]);
                return res.data.result;
            },
            queryIndexedEvents: async (query) => {
                const res = await this.post("bidx_queryIndexedEvents", [query]);
                return res.data.result;
            },
            getConfirmedBlockHeight: async () => {
                const res = await this.post("bidx_getConfirmedBlockHeight", []);
                return res.data.result;
            },
            decodeTransactionEvents: async (transactionHash, abi, resultFormat) => {
                const res = await this.post("bidx_decodeTransactionEvents", [transactionHash, abi, resultFormat]);
                return res.data.result;
            },
        };
        this.debug = {
            getTransactionStatus: async (txID) => {
                const res = await this.post("debug_getTransactionStatus", [txID], { validateStatus: (status) => status < 300 || status === 404 });
                return res.status === 404 ? undefined : res.data.result;
            },
        };
        this.reg = {
            registries: async () => {
                const res = await this.post("reg_registries", []);
                return res.data.result;
            },
            queryEntries: async (registryName, query, activeFilter) => {
                const res = await this.post("reg_queryEntries", [registryName, query, activeFilter]);
                return res.data.result;
            },
            queryEntriesWithProps: async (registryName, query, activeFilter) => {
                const res = await this.post("reg_queryEntriesWithProps", [registryName, query, activeFilter]);
                return res.data.result;
            },
            getEntryProperties: async (registryName, entryId, activeFilter) => {
                const res = await this.post("reg_getEntryProperties", [registryName, entryId, activeFilter]);
                return res.data.result;
            },
        };
        this.http = axios_1.default.create({
            ...options.requestConfig,
            baseURL: options.url,
        });
        this.logger = options.logger ?? console;
        this.onError =
            options.onError ??
                ((method, err) => {
                    this.logger.error(`JSON-RPC error from ${method} (${err.response?.status} ${err.response?.statusText})`, this.parseAxiosErrorMessage(err));
                });
    }
    getHttpInstance() {
        return this.http;
    }
    defaultHeaders() {
        return {
            Accept: "application/json",
            "Content-Type": "application/json",
        };
    }
    defaultPayload() {
        return {
            jsonrpc: "2.0",
            id: Date.now(),
        };
    }
    getVerifiers(...lookups) {
        return lookups.map((lookup) => new verifier_1.PaladinVerifier(this, lookup));
    }
    parseAxiosErrorMessage(err) {
        if (err instanceof axios_1.AxiosError && err.response?.data?.error) {
            return err.response.data.error?.message || err.response.data.error;
        }
        return `${err}`;
    }
    async post(method, params, config) {
        let res;
        try {
            res = await this.http.post("/", { ...this.defaultPayload(), method, params }, { ...config, headers: this.defaultHeaders() });
        }
        catch (err) {
            this.onError(method, err);
            throw err;
        }
        // JSON/RPC errors are returned with HTTP 200; detect and surface them
        const data = res.data;
        if (data?.error) {
            const rpcErr = new axios_1.AxiosError(data.error.message || JSON.stringify(data.error), String(data.error.code), res.config, undefined, res);
            this.onError(method, rpcErr);
            throw rpcErr;
        }
        return res;
    }
    async pollForReceipt(txID, waitMs, full) {
        for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS) {
            var receipt = full
                ? await this.ptx.getTransactionReceiptFull(txID)
                : await this.ptx.getTransactionReceipt(txID);
            if (receipt != undefined) {
                return receipt;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        this.logger.error(`Failed while waiting for receipt: ${txID}`);
        return undefined;
    }
    async pollForPreparedTransaction(txID, waitMs) {
        for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS) {
            var receipt = await this.ptx.getPreparedTransaction(txID);
            if (receipt != undefined) {
                return receipt;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        this.logger.error(`Failed while waiting for prepare: ${txID}`);
        return undefined;
    }
    /**
     * @deprecated Use ptx.prepareTransaction instead
     */
    async prepareTransaction(transaction) {
        return this.ptx.prepareTransaction(transaction);
    }
    /**
     * @deprecated Use ptx.sendTransaction instead
     */
    async sendTransaction(transaction) {
        return this.ptx.sendTransaction(transaction);
    }
    /**
     * @deprecated Use ptx.call instead
     */
    async call(transaction) {
        return this.ptx.call(transaction);
    }
    /**
     * @deprecated Use ptx.queryTransactions instead
     */
    async queryTransactions(query) {
        return this.ptx.queryTransactions(query);
    }
    /**
     * @deprecated Use ptx.getTransaction or ptx.getTransactionFull instead
     */
    async getTransaction(txID, full) {
        return full
            ? this.ptx.getTransactionFull(txID)
            : this.ptx.getTransaction(txID);
    }
    /**
     * @deprecated Use ptx.getPreparedTransaction instead
     */
    async getPreparedTransaction(txID) {
        return this.ptx.getPreparedTransaction(txID);
    }
    /**
     * @deprecated Use ptx.queryTransactionReceipts instead
     */
    async queryTransactionReceipts(query) {
        return this.ptx.queryTransactionReceipts(query);
    }
    /**
     * @deprecated Use ptx.getTransactionReceipt or ptx.getTransactionReceiptFull instead
     */
    async getTransactionReceipt(txID, full) {
        return full
            ? this.ptx.getTransactionReceiptFull(txID)
            : this.ptx.getTransactionReceipt(txID);
    }
    /**
     * @deprecated Use ptx.getStateReceipt instead
     */
    async getStateReceipt(txID) {
        return this.ptx.getStateReceipt(txID);
    }
    /**
     * @deprecated Use ptx.getDomainReceipt instead
     */
    async getDomainReceipt(domain, txID) {
        return this.ptx.getDomainReceipt(domain, txID);
    }
    /**
     * @deprecated Use ptx.resolveVerifier instead
     */
    async resolveVerifier(lookup, algorithm, verifierType) {
        return this.ptx.resolveVerifier(lookup, algorithm, verifierType);
    }
    /**
     * @deprecated Use ptx.storeABI instead
     */
    async storeABI(abi) {
        return this.ptx.storeABI(abi);
    }
    /**
     * @deprecated Use ptx.getStoredABI instead
     */
    async getStoredABI(hash) {
        return this.ptx.getStoredABI(hash);
    }
    /**
     * @deprecated Use ptx.decodeCall instead
     */
    async decodeCall(callData, dataFormat) {
        return this.ptx.decodeCall(callData, dataFormat);
    }
    /**
     * @deprecated Use ptx.decodeEvent instead
     */
    async decodeEvent(topics, data) {
        return this.ptx.decodeEvent(topics, data);
    }
    /**
     * @deprecated Use ptx.decodeError instead
     */
    async decodeError(revertError, dataFormat) {
        return this.ptx.decodeError(revertError, dataFormat);
    }
    /**
     * @deprecated Use bidx.decodeTransactionEvents instead
     */
    async decodeTransactionEvents(transactionHash, abi, resultFormat) {
        return this.bidx.decodeTransactionEvents(transactionHash, abi, resultFormat);
    }
    /**
     * @deprecated Use pstate.listSchemas instead
     */
    async listSchemas(domain) {
        return this.pstate.listSchemas(domain);
    }
    /**
     * @deprecated Use pstate.queryStates instead
     */
    async queryStates(domain, schema, query, status) {
        return this.pstate.queryStates(domain, schema, query, status);
    }
    /**
     * @deprecated Use pstate.queryContractStates instead
     */
    async queryContractStates(domain, contractAddress, schema, query, status) {
        return this.pstate.queryContractStates(domain, contractAddress, schema, query, status);
    }
    /**
     * @deprecated Use pgroup.createGroup instead
     */
    async createPrivacyGroup(pgroup) {
        return this.pgroup.createGroup(pgroup);
    }
    /**
     * @deprecated Use pgroup.getGroupById instead
     */
    async getPrivacyGroupById(domainName, id) {
        return this.pgroup.getGroupById(domainName, id);
    }
    /**
     * @deprecated Use pgroup.getGroupByAddress instead
     */
    async getPrivacyGroupByAddress(address) {
        return this.pgroup.getGroupByAddress(address);
    }
    /**
     * @deprecated Use pgroup.sendTransaction instead
     */
    async sendPrivacyGroupTransaction(txi) {
        return this.pgroup.sendTransaction(txi);
    }
    /**
     * @deprecated Use pgroup.call instead
     */
    async callPrivacyGroup(txi) {
        return this.pgroup.call(txi);
    }
    /**
     * @deprecated Use ptx.createReceiptListener instead
     */
    async createReceiptListener(listener) {
        return this.ptx.createReceiptListener(listener);
    }
    /**
     * @deprecated Use ptx.deleteReceiptListener instead
     */
    async deleteReceiptListener(name) {
        return this.ptx.deleteReceiptListener(name);
    }
    /**
     * @deprecated Use ptx.getReceiptListener instead
     */
    async getReceiptListener(name) {
        return this.ptx.getReceiptListener(name);
    }
    /**
     * @deprecated Use ptx.createBlockchainEventListener instead
     */
    async createBlockchainEventListener(listener) {
        return this.ptx.createBlockchainEventListener(listener);
    }
    /**
     * @deprecated Use ptx.deleteBlockchainEventListener instead
     */
    async deleteBlockchainEventListener(name) {
        return this.ptx.deleteBlockchainEventListener(name);
    }
    /**
     * @deprecated Use ptx.getBlockchainEventListener instead
     */
    async getBlockchainEventListener(name) {
        return this.ptx.getBlockchainEventListener(name);
    }
}
exports.default = PaladinClient;
