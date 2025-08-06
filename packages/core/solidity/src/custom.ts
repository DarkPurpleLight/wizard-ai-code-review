import type { Contract } from './contract';
import { ContractBuilder } from './contract';
import type { CommonOptions } from './common-options';
import { withCommonDefaults, defaults as commonDefaults } from './common-options';
import { setUpgradeable } from './set-upgradeable';
import { setInfo } from './set-info';
import { setAccessControl } from './set-access-control';
import { addPausable } from './add-pausable';
import { printContract } from './print';
import { addSuperchainMessaging } from './add-superchain-messaging';

export const CrossChainMessagingOptions = [false, 'superchain'] as const;
export type CrossChainMessaging = (typeof CrossChainMessagingOptions)[number];

export interface CustomOptions extends CommonOptions {
  name: string;
  crossChainMessaging?: CrossChainMessaging;
  crossChainFunctionName?: string;
  pausable?: boolean;
}

export const defaults: Required<CustomOptions> = {
  name: 'MyContract',
  crossChainMessaging: false,
  crossChainFunctionName: 'myFunction',
  pausable: false,
  access: commonDefaults.access,
  upgradeable: commonDefaults.upgradeable,
  info: commonDefaults.info,
} as const;

/**
 * Returns a `CustomOptions` object with all optional fields populated using default values where not provided.
 *
 * Ensures that cross-chain messaging, cross-chain function name, and pausable options are always defined.
 *
 * @returns The input options merged with defaults, guaranteeing all fields are set.
 */
function withDefaults(opts: CustomOptions): Required<CustomOptions> {
  return {
    ...opts,
    ...withCommonDefaults(opts),
    crossChainMessaging: opts.crossChainMessaging ?? defaults.crossChainMessaging,
    crossChainFunctionName: opts.crossChainFunctionName ?? defaults.crossChainFunctionName,
    pausable: opts.pausable ?? defaults.pausable,
  };
}

export function printCustom(opts: CustomOptions = defaults): string {
  return printContract(buildCustom(opts));
}

export function isAccessControlRequired(opts: Partial<CustomOptions>): boolean {
  return opts.pausable || opts.upgradeable === 'uups';
}

/**
 * Constructs a customizable smart contract with optional features such as cross-chain messaging, pausable functionality, access control, upgradeability, and metadata.
 *
 * Builds the contract according to the provided options, applying defaults where necessary. If cross-chain messaging is set to `'superchain'`, the contract includes superchain messaging support with the specified function name. Additional features like pausable functionality, access control, upgradeability, and metadata are configured based on the options.
 *
 * @returns The constructed contract instance with the selected features enabled
 */
export function buildCustom(opts: CustomOptions): Contract {
  const allOpts = withDefaults(opts);

  const c = new ContractBuilder(allOpts.name);

  const { access, upgradeable, info } = allOpts;

  if (allOpts.crossChainMessaging === 'superchain') {
    addSuperchainMessaging(c, allOpts.crossChainFunctionName, allOpts.access, allOpts.pausable);
  }

  if (allOpts.pausable) {
    addPausable(c, access, []);
  }

  setAccessControl(c, access);
  setUpgradeable(c, upgradeable, access);
  setInfo(c, info);

  return c;
}
