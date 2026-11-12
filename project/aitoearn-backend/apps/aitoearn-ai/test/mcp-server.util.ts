import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

export async function inspectMcpServer({ instance }: McpSdkServerConfigWithInstance) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })

  try {
    await instance.connect(serverTransport)
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    return {
      toolNames: tools.map(tool => tool.name),
      version: client.getServerVersion()?.version,
    }
  }
  finally {
    await client.close()
    await instance.close()
  }
}
