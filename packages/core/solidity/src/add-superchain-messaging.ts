import type { ContractBuilder } from './contract';
import { type BaseFunction } from './contract';
import { OptionsError } from './error';
import type { Access } from './set-access-control';
import { requireAccessControl } from './set-access-control';
import { toIdentifier } from './utils/to-identifier';

/**
 * Augments a contract builder with cross-chain messaging support using the Superchain pattern.
 *
 * Adds custom errors, an immutable cross-domain messenger variable, a modifier to restrict cross-domain callbacks, and generates source and destination functions for secure cross-chain calls. The generated functions can be optionally access-controlled and pausable.
 *
 * @param functionName - The name of the function to expose for cross-chain messaging. It will be sanitized to a valid Solidity identifier.
 * @param access - Access control configuration for the generated source function.
 * @param pausable - Whether the generated functions should include pausing capability.
 */
export function addSuperchainMessaging(c: ContractBuilder, functionName: string, access: Access, pausable: boolean) {
  const sanitizedFunctionName = safeSanitizeFunctionName(functionName);

  addCustomErrors(c);
  addCrossDomainMessengerImmutable(c);
  addOnlyCrossDomainCallbackModifier(c);
  addSourceFunction(sanitizedFunctionName, access, c, pausable);
  addDestinationFunction(sanitizedFunctionName, c, pausable);
}

/**
 * Converts a string to a valid Solidity function identifier or throws if invalid.
 *
 * @param functionName - The input string to sanitize as a function name
 * @returns The sanitized Solidity-compatible function name
 * @throws OptionsError if the input cannot be converted to a valid identifier
 */
function safeSanitizeFunctionName(functionName: string) {
  const sanitizedFunctionName = toIdentifier(functionName, false);
  if (sanitizedFunctionName.length === 0) {
    throw new OptionsError({
      crossChainFunctionName: 'Not a valid function name',
    });
  }
  return sanitizedFunctionName;
}

/**
 * Adds custom error definitions for cross-domain messaging to the contract builder.
 *
 * Defines errors for unauthorized messenger calls, invalid cross-domain senders, and invalid destination chain IDs.
 */
function addCustomErrors(c: ContractBuilder) {
  c.addCustomError('CallerNotL2ToL2CrossDomainMessenger');
  c.addCustomError('InvalidCrossDomainSender');
  c.addCustomError('InvalidDestination');
}

/**
 * Adds an immutable public variable for the L2-to-L2 cross-domain messenger to the contract.
 *
 * Imports the required messenger interface and predeploy address, and defines the `messenger` variable for cross-chain messaging functionality.
 */
function addCrossDomainMessengerImmutable(c: ContractBuilder) {
  c.addImportOnly({
    name: 'IL2ToL2CrossDomainMessenger',
    path: '@eth-optimism/contracts-bedrock/src/L2/IL2ToL2CrossDomainMessenger.sol',
    transpiled: false,
  });
  c.addImportOnly({
    name: 'Predeploys',
    path: '@eth-optimism/contracts-bedrock/src/libraries/Predeploys.sol',
    transpiled: false,
  });

  const allowImmutableNatspec = {
    key: '@custom:oz-upgrades-unsafe-allow',
    value: 'state-variable-immutable',
  };
  c.addVariable(
    'IL2ToL2CrossDomainMessenger public immutable messenger = IL2ToL2CrossDomainMessenger(Predeploys.L2_TO_L2_CROSS_DOMAIN_MESSENGER);',
    [allowImmutableNatspec],
  );
}

/**
 * Adds a modifier that restricts function execution to valid cross-domain callbacks from the messenger contract.
 *
 * The modifier reverts if the caller is not the designated messenger contract or if the cross-domain message sender does not match the current contract address.
 */
function addOnlyCrossDomainCallbackModifier(c: ContractBuilder) {
  c.addModifierDefinition({
    name: 'onlyCrossDomainCallback',
    code: [
      'if (msg.sender != address(messenger)) revert CallerNotL2ToL2CrossDomainMessenger();',
      'if (messenger.crossDomainMessageSender() != address(this)) revert InvalidCrossDomainSender();',
      '_;',
    ],
  });
}

/**
 * Adds a public function to the contract for initiating a cross-chain call to a specified destination chain.
 *
 * The generated function is named `call<SanitizedFunctionName>` and sends a cross-chain message using the messenger contract. It checks that the destination chain ID is not the current chain and encodes a call to the corresponding destination function. Access control and pausing can be optionally enforced.
 *
 * @param sanitizedFunctionName - The sanitized name of the destination function to be called cross-chain.
 * @param access - Access control specification; if provided, restricts who can call this function.
 * @param pausable - If true, the function is only callable when the contract is not paused.
 */
function addSourceFunction(sanitizedFunctionName: string, access: Access, c: ContractBuilder, pausable: boolean) {
  const sourceFn: BaseFunction = {
    name: `call${sanitizedFunctionName.replace(/^(.)/, c => c.toUpperCase())}`,
    kind: 'public' as const,
    args: [{ name: 'toChainId', type: 'uint256' }],
  };

  if (access) {
    requireAccessControl(c, sourceFn, access, 'CROSSCHAIN_CALLER', 'crossChainCaller');
  } else {
    c.setFunctionComments(['/// @dev NOTE: This function is unprotected. Anyone can call this function.'], sourceFn);
  }

  if (pausable) {
    c.addModifier('whenNotPaused', sourceFn);
  }

  c.setFunctionBody(
    [
      'if (toChainId == block.chainid) revert InvalidDestination();',
      `messenger.sendMessage(toChainId, address(this), abi.encodeCall(this.${sanitizedFunctionName}, (/* TODO: Add arguments */)));`,
    ],
    sourceFn,
  );
}

/**
 * Adds an external destination function to the contract for handling cross-chain calls.
 *
 * This function is intended to be invoked by the cross-domain messenger when a message is received from another chain.
 * It is protected by the `onlyCrossDomainCallback` modifier to ensure only valid cross-chain messages can trigger it.
 * If `pausable` is true, the function is also guarded by the `whenNotPaused` modifier.
 *
 * @param sanitizedFunctionName - The validated name for the destination function to be added.
 */
function addDestinationFunction(sanitizedFunctionName: string, c: ContractBuilder, pausable: boolean) {
  const destFn: BaseFunction = {
    name: sanitizedFunctionName,
    kind: 'external' as const,
    args: [],
    argInlineComment: 'TODO: Add arguments',
  };
  c.setFunctionComments(
    [
      '/**',
      ' * @dev IMPORTANT: This function trusts contracts at the same address on other chains.',
      ' * If an unauthorized contract is deployed at the same address on any chain in the Superchain, it could allow',
      ' * malicious actors to invoke your function from that chain.',
      " * To prevent this, you must either design the deployer to allow only this contract's bytecode to be deployed",
      ' * through it, or use CREATE2 from a deployer contract that is itself deployed by an EOA you control.',
      ' */',
    ],
    destFn,
  );

  c.addModifier('onlyCrossDomainCallback', destFn);
  if (pausable) {
    c.addModifier('whenNotPaused', destFn);
  }

  c.addFunctionCode('// TODO: Implement logic for the function that will be called from another chain', destFn);
}
