import type {
  Contract,
  Parent,
  ContractFunction,
  FunctionArgument,
  Value,
  NatspecTag,
  ImportContract,
  CustomError,
  ModifierDefinition,
  Variable,
} from './contract';
import type { Options, Helpers } from './options';
import { withHelpers } from './options';

import type { Lines } from './utils/format-lines';
import { formatLines, spaceBetween } from './utils/format-lines';
import { mapValues } from './utils/map-values';
import SOLIDITY_VERSION from './solidity-version.json';
import { inferTranspiled } from './infer-transpiled';
import { compatibleContractsSemver } from './utils/version';
import { stringifyUnicodeSafe } from './utils/sanitize';

/**
 * Generates the complete Solidity source code for a contract from its abstract representation.
 *
 * Assembles license, pragma, imports, NatSpec comments, contract declaration with inheritance, variables, custom errors, modifier definitions, constructor, and all categorized functions into a formatted Solidity contract string.
 *
 * @returns The full Solidity contract source code as a string.
 */
export function printContract(contract: Contract, opts?: Options): string {
  const helpers = withHelpers(contract, opts);

  const fns = mapValues(sortedFunctions(contract), fns => fns.map(fn => printFunction(fn, helpers)));

  const hasOverrides = fns.override.some(l => l.length > 0);

  return formatLines(
    ...spaceBetween(
      [
        `// SPDX-License-Identifier: ${contract.license}`,
        `// Compatible with OpenZeppelin Contracts ${compatibleContractsSemver}`,
        `pragma solidity ^${SOLIDITY_VERSION};`,
      ],

      printImports(contract.imports, helpers),

      [
        ...printNatspecTags(contract.natspecTags),
        [`contract ${contract.name}`, ...printInheritance(contract, helpers), '{'].join(' '),

        spaceBetween(
          printVariables(contract.variables),
          printCustomErrors(contract.customErrors),
          printModifierDefinitions(contract.modifierDefinitions),
          printConstructor(contract, helpers),
          ...fns.code,
          ...fns.modifiers,
          hasOverrides ? [`// The following functions are overrides required by Solidity.`] : [],
          ...fns.override,
        ),

        `}`,
      ],
    ),
  );
}

/**
 * Generates Solidity code lines for contract variables, including their NatSpec comments if present.
 *
 * @param variables - The list of contract variables to render
 * @returns An array of lines representing each variable declaration with optional documentation
 */
function printVariables(variables: Variable[]): Lines[] {
  return variables.flatMap(v => {
    const lines: Lines[] = [];
    if (v.natspecTags) {
      lines.push(...printNatspecTags(v.natspecTags));
    }
    lines.push(v.code);
    return lines;
  });
}

/**
 * Returns Solidity error declarations for each custom error in the contract.
 *
 * @returns An array of lines, each defining a custom error in the format `error ErrorName();`
 */
function printCustomErrors(errors: CustomError[]): Lines[] {
  return errors.map(e => `error ${e.name}();`);
}

/**
 * Generates Solidity code lines for each modifier definition.
 *
 * @param modifierDefinitions - The list of modifier definitions to render
 * @returns An array of lines representing each Solidity modifier declaration
 */
function printModifierDefinitions(modifierDefinitions: ModifierDefinition[]): Lines[] {
  return modifierDefinitions.flatMap(def => [`modifier ${def.name}() {`, def.code, '}']);
}

/**
 * Returns the Solidity inheritance clause for a contract if it has parent contracts.
 *
 * @returns An array containing the inheritance clause string, or an empty array if there are no parents.
 */
function printInheritance(contract: Contract, { transformName }: Helpers): [] | [string] {
  if (contract.parents.length > 0) {
    return ['is ' + contract.parents.map(p => transformName(p.contract)).join(', ')];
  } else {
    return [];
  }
}

/**
 * Generates the Solidity constructor or initializer function for a contract.
 *
 * For upgradeable contracts, emits an `initialize` function with the `initializer` modifier and disables further initializers if needed. For non-upgradeable contracts, emits a standard constructor with parent initializers and constructor code if present. Returns an empty array if no constructor or initializer is required.
 *
 * @returns Lines representing the constructor or initializer function, or an empty array if not needed.
 */
function printConstructor(contract: Contract, helpers: Helpers): Lines[] {
  const hasParentParams = contract.parents.some(p => p.params.length > 0);
  const hasConstructorCode = contract.constructorCode.length > 0;
  const parentsWithInitializers = contract.parents.filter(hasInitializer);
  if (hasParentParams || hasConstructorCode || (helpers.upgradeable && parentsWithInitializers.length > 0)) {
    const parents = parentsWithInitializers.flatMap(p => printParentConstructor(p, helpers));
    const modifiers = helpers.upgradeable ? ['public initializer'] : parents;
    const args = contract.constructorArgs.map(a => printArgument(a, helpers));
    const body = helpers.upgradeable
      ? spaceBetween(
          parents.map(p => p + ';'),
          contract.constructorCode,
        )
      : contract.constructorCode;
    const head = helpers.upgradeable ? 'function initialize' : 'constructor';
    const constructor = printFunction2([], head, args, undefined, modifiers, body);
    if (!helpers.upgradeable) {
      return constructor;
    } else {
      return spaceBetween(DISABLE_INITIALIZERS, constructor);
    }
  } else if (!helpers.upgradeable) {
    return [];
  } else {
    return DISABLE_INITIALIZERS;
  }
}

const DISABLE_INITIALIZERS = [
  '/// @custom:oz-upgrades-unsafe-allow constructor',
  'constructor() {',
  ['_disableInitializers();'],
  '}',
];

function hasInitializer(parent: Parent) {
  // CAUTION
  // This list is validated by compilation of SafetyCheck.sol.
  // Always keep this list and that file in sync.
  return !['Initializable'].includes(parent.contract.name);
}

type SortedFunctions = Record<'code' | 'modifiers' | 'override', ContractFunction[]>;

// Functions with code first, then those with modifiers, then the rest
function sortedFunctions(contract: Contract): SortedFunctions {
  const fns: SortedFunctions = { code: [], modifiers: [], override: [] };

  for (const fn of contract.functions) {
    if (fn.code.length > 0) {
      fns.code.push(fn);
    } else if (fn.modifiers.length > 0) {
      fns.modifiers.push(fn);
    } else {
      fns.override.push(fn);
    }
  }

  return fns;
}

function printParentConstructor({ contract, params }: Parent, helpers: Helpers): [] | [string] {
  const useTranspiled = helpers.upgradeable && inferTranspiled(contract);
  const fn = useTranspiled ? `__${contract.name}_init` : contract.name;
  if (useTranspiled || params.length > 0) {
    return [fn + '(' + params.map(printValue).join(', ') + ')'];
  } else {
    return [];
  }
}

export function printValue(value: Value): string {
  if (typeof value === 'object') {
    if ('lit' in value) {
      return value.lit;
    } else if ('note' in value) {
      return `${printValue(value.value)} /* ${value.note} */`;
    } else {
      throw Error('Unknown value type');
    }
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return value.toFixed(0);
    } else {
      throw new Error(`Number not representable (${value})`);
    }
  } else {
    return stringifyUnicodeSafe(value);
  }
}

/**
 * Generates the Solidity source lines for a contract function, including its signature, modifiers, return types, and body.
 *
 * If the function overrides a parent and is not marked as final, a super call is appended to the body. Returns an empty array if the function has no code, modifiers, or meaningful overrides.
 *
 * @returns An array of formatted lines representing the function declaration and body.
 */
function printFunction(fn: ContractFunction, helpers: Helpers): Lines[] {
  const { transformName } = helpers;

  if (fn.override.size <= 1 && fn.modifiers.length === 0 && fn.code.length === 0 && !fn.final) {
    return [];
  }
  const modifiers: string[] = [fn.kind];

  if (fn.mutability !== 'nonpayable') {
    modifiers.push(fn.mutability);
  }

  if (fn.override.size === 1) {
    modifiers.push(`override`);
  } else if (fn.override.size > 1) {
    modifiers.push(`override(${[...fn.override].map(transformName).join(', ')})`);
  }

  modifiers.push(...fn.modifiers);

  if (fn.returns?.length) {
    modifiers.push(`returns (${fn.returns.join(', ')})`);
  }

  const code = [...fn.code];

  if (fn.override.size > 0 && !fn.final) {
    const superCall = `super.${fn.name}(${fn.args.map(a => a.name).join(', ')});`;
    code.push(fn.returns?.length ? 'return ' + superCall : superCall);
  }

  if (modifiers.length + fn.code.length > 1) {
    return printFunction2(
      fn.comments,
      'function ' + fn.name,
      fn.args.map(a => printArgument(a, helpers)),
      fn.argInlineComment,
      modifiers,
      code,
    );
  } else {
    return [];
  }
}

// generic for functions and constructors
/**
 * Formats a Solidity function or constructor declaration with optional comments, arguments, inline argument comment, modifiers, and code block.
 *
 * @param comments - NatSpec or documentation comments to include above the declaration
 * @param kindedName - The function or constructor keyword and name (e.g., 'function foo' or 'constructor')
 * @param args - List of argument strings for the function signature
 * @param argInlineComment - Optional inline comment to append inside the argument list
 * @param modifiers - List of Solidity modifiers to apply to the function
 * @param code - Lines representing the function or constructor body
 * @returns Lines representing the formatted function or constructor declaration
 */
function printFunction2(
  comments: string[],
  kindedName: string,
  args: string[],
  argInlineComment: string | undefined,
  modifiers: string[],
  code: Lines[],
): Lines[] {
  const fn: Lines[] = [...comments];

  const headingLength = [kindedName, ...args, ...modifiers].map(s => s.length).reduce((a, b) => a + b);

  const braces = code.length > 0 ? '{' : '{}';

  if (headingLength <= 72) {
    fn.push(
      [`${kindedName}(${args.join(', ')}${formatInlineComment(argInlineComment)})`, ...modifiers, braces].join(' '),
    );
  } else {
    fn.push(`${kindedName}(${args.join(', ')}${formatInlineComment(argInlineComment)})`, modifiers, braces);
  }

  if (code.length > 0) {
    fn.push(code, '}');
  }

  return fn;
}

/**
 * Formats a string as a Solidity-style inline comment for use in function signatures.
 *
 * @param comment - The comment text to format, or undefined if no comment is provided
 * @returns The formatted inline comment, or an empty string if no comment is given
 */
function formatInlineComment(comment: string | undefined): string {
  return comment ? `/* ${comment} */` : '';
}

/**
 * Formats a function argument as a Solidity parameter string, transforming the type name if it is a contract reference.
 *
 * @param arg - The function argument to format
 * @returns The formatted Solidity parameter string in the form `type name`
 */
function printArgument(arg: FunctionArgument, { transformName }: Helpers): string {
  let type: string;
  if (typeof arg.type === 'string') {
    if (/^[A-Z]/.test(arg.type)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      `Type ${arg.type} is not a primitive type. Define it as a ContractReference`;
    }
    type = arg.type;
  } else {
    type = transformName(arg.type);
  }

  return [type, arg.name].join(' ');
}

function printNatspecTags(tags: NatspecTag[]): string[] {
  return tags.map(({ key, value }) => `/// ${key} ${value}`);
}

function printImports(imports: ImportContract[], helpers: Helpers): string[] {
  // Sort imports by name
  imports.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  const lines: string[] = [];
  imports.map(p => {
    const importContract = helpers.transformImport(p);
    lines.push(`import {${importContract.name}} from "${importContract.path}";`);
  });

  return lines;
}
