import type { VisionApiResponse } from '../../../ai/libs/volcengine'
import { createSdkMcpServer, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Injectable, Logger } from '@nestjs/common'
import { UserType } from '@yikart/common'
import { z } from 'zod'
import { AiAvailabilityService } from '../../../ai-availability'
import { AideoService } from '../../../ai/aideo'
import { AideoTaskStatus, SkillType } from '../../../ai/libs/volcengine'
import { McpServerName } from '../../agent.constants'
import { errorResult, successResult, wrapTool } from '../mcp.utils'

const submitAideoTaskPromptSchema = z.object({
  prompt: z.string(),
  multiInputs: z.array(z.string()),
})

const getAideoTaskStatusSchema = z.object({
  taskId: z.string(),
})

export enum AideoToolName {
  SubmitAideoTask = 'submitAideoTask',
  GetAideoTaskStatus = 'getAideoTaskStatus',
}

@Injectable()
export class AideoMcp {
  private readonly logger = new Logger(AideoMcp.name)

  constructor(
    private readonly aideoService: AideoService,
    private readonly aiAvailability: AiAvailabilityService,
  ) { }

  createSubmitAideoTaskTool(userId: string, userType: UserType) {
    return wrapTool(
      this.logger,
      AideoToolName.SubmitAideoTask,
      `Submit an AI-powered video processing task using natural language instructions. Provide prompt describing the desired operation, and multiInputs (array of video/image/audio URLs).

**Capabilities**:
- Multiple Images → Video: Stitch/combine images into video with transitions
- Multiple Videos → Single Video: Concatenate/merge video clips
- Video + Audio: Merge video with background music
- Highlight Extraction: Extract exciting clips for trailers
- Video Translation: Translate subtitles, clone voice, sync lip movements
- Subtitle Removal: Remove hardcoded subtitles using AI inpainting
- Video Understanding: Generate summaries, keywords, plot analysis (up to 2 hours)

**Video Translation - Subtitle Recognition**:
- Default: ASR (speech recognition) - extracts text from audio track, suitable for videos without hardcoded subtitles
- OCR: Add "ocr" or "硬字幕" or "hardcoded" in prompt - extracts text from video frames, use when video has burned-in subtitles
- Vision: Add "vision" in prompt - AI-based understanding of both visual and audio content

Note: For video style transfer (comic/anime), use submitVideoStyleTransfer instead. Processing time: ~10 minutes per 1-minute video. Returns taskId for status tracking.`,
      submitAideoTaskPromptSchema.shape,
      async ({ prompt, multiInputs }) => {
        const result = await this.aideoService.submitAideoTask({
          userId,
          userType,
          prompt,
          multiInputs,
        })
        return successResult(`Aideo task submitted successfully, taskId: ${result.taskId}`)
      },
      this.aiAvailability,
    )
  }

  createGetAideoTaskStatusTool(userId: string, userType: UserType) {
    return wrapTool(
      this.logger,
      AideoToolName.GetAideoTaskStatus,
      `Get AI video processing task status and results.

**Returns by Task Type**:
- Translation: Complete translated video URL
- Erase: Clean video without subtitles
- Highlight: Array of extracted highlight clip URLs
- VCreative: Edited video URL
- Vision: Summary, keywords, plot analysis (JSON)`,
      getAideoTaskStatusSchema.shape,
      async ({ taskId }) => {
        const result = await this.aideoService.getAideoTask({ userId, userType, taskId })
        if (result.status === AideoTaskStatus.Failed) {
          return errorResult(`Aideo task failed. Error: ${result.errorMessage || 'Unknown error'}`)
        }

        if (result.status === AideoTaskStatus.Completed) {
          let outputInfo = `Task completed successfully!\n\nStatus: ${result.status}\n`
          const visionResponses = result.apiResponses?.filter(response =>
            response['VodTaskType'] === SkillType.Vision || response['Vision'],
          ) ?? []

          if (result.skillType === SkillType.Vision || visionResponses.length > 0) {
            const analysis = visionResponses.map((response) => {
              const vision = response['Vision'] as VisionApiResponse['Vision']
              return [vision?.Output?.Task?.Vision?.Content, vision?.Content]
                .find(content => typeof content === 'string' && content.trim())
                ?.trim()
            }).filter(Boolean).join('\n\n')

            return analysis
              ? successResult(`${outputInfo}\nVision Analysis Results:\n${analysis}`)
              : errorResult('Aideo task completed, but no video analysis text was returned.')
          }

          if (result.apiResponses && result.apiResponses.length > 0) {
            const apiResponse = result.apiResponses[0]
            const aiTranslation = apiResponse['AITranslation']
            const erase = apiResponse['Erase']
            const highlight = apiResponse['Highlight']
            const vCreative = apiResponse['VCreative']

            if (aiTranslation?.ProjectInfo?.OutputVideo?.Url) {
              outputInfo += `\nOutput Video URL: ${aiTranslation.ProjectInfo.OutputVideo.Url}`
              if (aiTranslation.ProjectInfo.OutputVideo.Vid) {
                outputInfo += `\nOutput VID: ${aiTranslation.ProjectInfo.OutputVideo.Vid}`
              }
            }
            else if (erase?.Output?.Task?.Erase?.File?.url) {
              outputInfo += `\nOutput Video URL: ${erase.Output.Task.Erase.File.url}`
            }
            else if (highlight?.Edits && highlight.Edits.length > 0) {
              outputInfo += `\n\nHighlight Clips:`
              highlight.Edits.forEach((edit: { url?: string }, index: number) => {
                if (edit.url) {
                  outputInfo += `\n  Clip ${index + 1}: ${edit.url}`
                }
              })
            }
            else if (vCreative?.OutputJson) {
              const outputJson = vCreative.OutputJson
              if (typeof outputJson !== 'string') {
                const url = outputJson.Result?.url || outputJson.url
                if (url) {
                  outputInfo += `\nOutput Video URL: ${url}`
                }
              }
            }
          }

          return successResult(outputInfo)
        }

        return successResult(`Task status: ${result.status}. Please continue polling.`)
      },
      this.aiAvailability,
    )
  }

  createServer(userId: string, userType: UserType): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: McpServerName.Aideo,
      version: '1.0.0',
      tools: [
        this.createSubmitAideoTaskTool(userId, userType),
        this.createGetAideoTaskStatusTool(userId, userType),
      ],
    })
  }
}
