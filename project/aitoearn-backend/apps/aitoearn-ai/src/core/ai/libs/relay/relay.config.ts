import { createZodDto } from '@yikart/common'
import { z } from 'zod'

export const relayConfigSchema = z.object({
  url: z.string().describe('AI Relay 服务端 Base URL（不含 /api 前缀，服务端会自动拼接 /api/ai/... 路径），用于视频中继 channel 出站调用'),
  apiKey: z.string().describe('AI Relay API Key，通过 x-api-key header 鉴权'),
  openAiVideoModels: z.record(z.string(), z.record(z.string(), z.string())).optional()
    .describe('启用 OpenAI 视频接口，按 AiToEarn 模型和分辨率映射上游模型'),
  multipartVideoReferenceModels: z.array(z.string()).optional()
    .describe('通过 OpenAI 视频接口上传参考文件的 AiToEarn 模型'),
  timeout: z.number().default(300 * 1000).describe('请求超时时间（毫秒）'),
})

export class RelayConfig extends createZodDto(relayConfigSchema) {}
