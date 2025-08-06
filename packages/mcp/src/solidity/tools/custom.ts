import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CustomOptions } from '@openzeppelin/wizard';
import { custom } from '@openzeppelin/wizard';
import { safePrintSolidityCodeBlock, makeDetailedPrompt } from '../../utils';
import { customSchema } from '../schemas';
import { solidityPrompts } from '@openzeppelin/wizard-common';

/**
 * Registers a custom Solidity contract generation tool with the MCP server.
 *
 * The registered tool accepts contract customization options, including cross-chain messaging parameters, and returns formatted Solidity code based on the provided configuration.
 *
 * @returns The registered tool instance
 */
export function registerSolidityCustom(server: McpServer): RegisteredTool {
  return server.tool(
    'solidity-custom',
    makeDetailedPrompt(solidityPrompts.Custom),
    customSchema,
    async ({ name, pausable, crossChainMessaging, crossChainFunctionName, access, upgradeable, info }) => {
      const opts: CustomOptions = {
        name,
        pausable,
        crossChainMessaging,
        crossChainFunctionName,
        access,
        upgradeable,
        info,
      };
      return {
        content: [
          {
            type: 'text',
            text: safePrintSolidityCodeBlock(() => custom.print(opts)),
          },
        ],
      };
    },
  );
}
