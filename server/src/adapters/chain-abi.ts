// Event and (state-changing) function fragments of the contracts the Besu models call (Zeto, Noto/Pente, Atom, Stealth), used to
// name the logs of a receipt and the function of a tx (ARCHITECTURE.md §2.3 Receipts, §2.3 Trace). Generated 2026-11-04 from the ABI
// file named on each line; several are build outputs a fresh checkout does not have, so the fragments are kept here.
// A log or input that matches none of them is shown raw.
export const EVENT_ABI = [
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)', // besu/stealth-address/out/ERC5564Announcer.sol/ERC5564Announcer.json
  'event Approval(address indexed owner, address indexed spender, uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'event ApprovalByPartition(bytes32 indexed partition, address indexed owner, address indexed spender, uint256 value)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event AtomDeployed(address addr)', // besu/zeto/abis/AtomFactory.json
  'event AtomStatusChanged(uint8 status)', // besu/zeto/abis/Atom.json
  'event AuthorizedOperator(address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event AuthorizedOperatorByPartition(bytes32 indexed partition, address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event BondRefundFailed(bytes32 indexed tradeId)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event Cancelled(bytes32 indexed tradeId, bool bondRefunded, uint256 rdRefunded)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event ChangedPartition(bytes32 indexed fromPartition, bytes32 indexed toPartition, uint256 value)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event DocumentRemoved(bytes32 indexed name, string uri, bytes32 documentHash)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event DocumentUpdated(bytes32 indexed name, string uri, bytes32 documentHash)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event EIP712DomainChanged()', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event EscrowCreated(bytes32 indexed tradeId, address indexed escrow)', // besu/stealth-address/out/DvPFactory.sol/DvPFactory.json
  'event Initialized(uint64 version)', // besu/zeto/abis/Atom.json
  'event Issued(address indexed operator, address indexed to, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event IssuedByPartition(bytes32 indexed partition, address indexed operator, address indexed to, uint256 value, bytes data, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event LegReleaseFailed(uint256 index, address contractAddress, bytes32 lockId, bytes reason)', // besu/noto+pente/bond/build/bond/src/abis/RestrictedAtom.json
  'event LegReleased(uint256 index, address contractAddress, bytes32 lockId)', // besu/noto+pente/bond/build/bond/src/abis/RestrictedAtom.json
  'event LockCancelled(bytes32 indexed lockId, address indexed spender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockCreated(bytes32 indexed lockId, address indexed owner, address indexed spender, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockDelegateChanged(uint256[] lockedOutputs, address indexed oldDelegate, address indexed newDelegate, bytes data)', // besu/zeto/abis/IZetoLockable.json
  'event LockDelegated(bytes32 indexed lockId, address indexed previousSpender, address indexed newSpender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockSpent(bytes32 indexed lockId, address indexed spender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockUpdated(bytes32 indexed lockId, address indexed owner, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event MinterAdded(address indexed account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event MinterRemoved(address indexed account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event NotoLockCancelled(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, bytes32[] inputs, bytes32[] outputs, bytes txData, bytes32 oldLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockCreated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes32[] inputs, bytes32[] outputs, bytes32[] contents, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockDelegated(bytes32 indexed txId, bytes32 indexed lockId, address indexed previousSpender, address newSpender, bytes32 oldLockState, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockSpent(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, bytes32[] inputs, bytes32[] outputs, bytes txData, bytes32 oldLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockUpdated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes32[] contents, bytes32 oldLockState, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event PenteApproved(bytes32 txId, address delegate, bytes32 transitionHash)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event PenteTransition(bytes32 txId, bytes32[] inputs, bytes32[] reads, bytes32[] outputs, bytes32[] info)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event Redeemed(address indexed operator, address indexed from, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RedeemedByPartition(bytes32 indexed partition, address indexed operator, address indexed from, uint256 value, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RevokedOperator(address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RevokedOperatorByPartition(bytes32 indexed partition, address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event Settled(bytes32 indexed tradeId)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event Transfer(address indexed from, address indexed to, uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'event Transfer(bytes32 txId, address indexed operator, bytes32[] inputs, bytes32[] outputs, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event TransferByPartition(bytes32 indexed fromPartition, address operator, address indexed from, address indexed to, uint256 value, bytes data, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event UTXOBurn(uint256[] inputs, uint256 output, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOMint(uint256[] outputs, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOTransfer(uint256[] inputs, uint256[] outputs, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOTransferWithEncryptedValues(uint256[] inputs, uint256[] outputs, uint256 encryptionNonce, uint256[2] ecdhPublicKey, uint256[] encryptedValues, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOWithdraw(uint256 amount, uint256[] inputs, uint256 output, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOsLocked(uint256[] inputs, uint256[] outputs, uint256[] lockedOutputs, address indexed delegate, address indexed submitter, bytes data)', // besu/zeto/abis/IZetoLockable.json
  'event Upgraded(address indexed implementation)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event ZetoLockCancelled(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, uint256[] lockedInputs, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockCreated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, uint256[] inputs, uint256[] outputs, uint256[] lockedOutputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockDelegated(bytes32 indexed txId, bytes32 indexed lockId, address indexed from, address to, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockSpent(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, uint256[] lockedInputs, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockUpdated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes data)', // besu/zeto/abis/ZetoV1Events.json
];
export const FUNCTION_ABI = [
  'function addMinter(address account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)', // besu/stealth-address/out/ERC5564Announcer.sol/ERC5564Announcer.json
  'function approve(address spender, uint256 value) returns (bool)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function approveByPartition(bytes32 partition, address spender, uint256 value) returns (bool)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function approveTransition(bytes32 txId, address delegate, bytes32 transitionHash, bytes[] signatures)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'function authorizeOperator(address operator)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function authorizeOperatorByPartition(bytes32 partition, address operator)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function burn(uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function burnFrom(address account, uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function cancel()', // besu/zeto/abis/Atom.json
  'function cancelLock(bytes32 lockId, bytes cancelArgs, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function create((address contractAddress, bytes callData)[] operations)', // besu/zeto/abis/AtomFactory.json
  'function create((address contractAddress, bytes callData)[] operations, (address contractAddress, bytes32 lockId, bytes callData)[] cancelOperations, address[] parties, address executor) returns (address)', // besu/noto+pente/bond/build/bond/src/abis/RestrictedAtomFactory.json
  'function create((bytes32 tradeId, address bond, bytes32 partition, uint256 bondAmount, address rd, uint256 rdAmount, address seller, address buyer, uint256 expiry, uint256 refundWindow, (address receiver, bytes ephemeralPubKey, bytes1 viewTag, bytes memo) bondLeg, (address receiver, bytes ephemeralPubKey, bytes1 viewTag, bytes memo) rdLeg) t, bytes settleCert, bytes refundCert) returns (address)', // besu/stealth-address/out/DvPFactory.sol/DvPFactory.json
  'function createLock(bytes createArgs, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data) returns (bytes32 lockId)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function delegateLock(bytes32 lockId, bytes delegateArgs, address newSpender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function domainSeparator() returns (bytes32)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function execute()', // besu/zeto/abis/Atom.json
  'function initialize((address contractAddress, bytes callData)[] operations)', // besu/zeto/abis/Atom.json
  'function initialize((address contractAddress, bytes callData)[] operations, (address contractAddress, bytes32 lockId, bytes callData)[] cancelOperations, address[] parties, address executor_)', // besu/noto+pente/bond/build/bond/src/abis/RestrictedAtom.json
  'function initialize(bytes config)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'function initialize(string name_, string symbol_, address notary)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function issue(address tokenHolder, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function issueByPartition(bytes32 partition, address tokenHolder, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function issueByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function migrate(address newContractAddress, bool definitive)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function mint(address to, uint256 amount)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function mint(bytes32 txId, bytes32[] outputs, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function mintStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function operatorRedeemByPartition(bytes32 partition, address tokenHolder, uint256 value, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function operatorTransferByPartition(bytes32 partition, address from, address to, uint256 value, bytes data, bytes operatorData) returns (bytes32)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function preAuthorizeUpgrade(address newImplementation, bytes[] signatures)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'function redeem(uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function redeemByPartition(bytes32 partition, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function redeemFrom(address from, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function removeDocument(bytes32 documentName)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function removeMinter(address account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function renounceControl()', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function renounceIssuance()', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function renounceMinter()', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function renounceOwnership()', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function retryRelease(uint256 index)', // besu/noto+pente/bond/build/bond/src/abis/RestrictedAtom.json
  'function revokeOperator(address operator)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function revokeOperatorByPartition(bytes32 partition, address operator)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function setCertificates(bytes settleCert_, bytes refundCert_)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'function setControllers(address[] operators)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function setDefaultPartitions(bytes32[] partitions)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function setDocument(bytes32 documentName, string uri, bytes32 documentHash)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function setPartitionControllers(bytes32 partition, address[] operators)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function setTokenExtension(address extension, string interfaceLabel, bool removeOldExtensionRoles, bool addMinterRoleForExtension, bool addControllerRoleForExtension)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function settle()', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'function simulate() returns ((bool success, bytes returnData)[] results)', // besu/zeto/abis/Atom.json
  'function spendLock(bytes32 lockId, bytes spendArgs, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function transfer(address to, uint256 value) returns (bool)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function transfer(bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function transferByPartition(bytes32 partition, address to, uint256 value, bytes data) returns (bytes32)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function transferFrom(address from, address to, uint256 value) returns (bool)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'function transferFromWithData(address from, address to, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function transferOwnership(address newOwner)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function transferWithData(address to, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'function transition(bytes32 txId, (bytes32[] inputs, bytes32[] reads, bytes32[] outputs, bytes32[] info) states, (address contractAddress, bytes encodedCall)[] externalCalls, bytes[] signatures)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'function transitionWithApproval(bytes32 txId, (bytes32[] inputs, bytes32[] reads, bytes32[] outputs, bytes32[] info) states, (address contractAddress, bytes encodedCall)[] externalCalls)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'function updateLock(bytes32 lockId, bytes updateArgs, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'function upgradeToAndCall(address newImplementation, bytes data) payable', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
];
