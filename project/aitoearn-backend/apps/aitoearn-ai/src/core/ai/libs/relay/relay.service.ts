import { Injectable } from '@nestjs/common'
import { AppException, ResponseCode } from '@yikart/common'
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios'
import { AiAvailabilityService } from '../../../ai-availability'
import { RelayConfig } from './relay.config'
import { RelayVideoCallbackDto, RelayVideoGenerationRequest, RelayVideoReferences, RelayVideoSubmitResponse } from './relay.interface'

interface RelayCommonResponse<T> {
  code?: number
  message?: string
  data?: T
}

interface OpenAiRelayVideo extends RelayVideoCallbackDto {
  task_id?: string
  fail_reason?: string
}

@Injectable()
export class RelayLibService {
  private readonly httpClient: AxiosInstance

  constructor(
    private readonly config: RelayConfig,
    private readonly aiAvailability: AiAvailabilityService,
  ) {
    this.httpClient = axios.create({
      baseURL: this.config.url,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(this.config.openAiVideoModels
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : { 'x-api-key': this.config.apiKey }),
      },
    })

    this.httpClient.interceptors.response.use(
      response => this.normalizeResponse(response),
      (error: AxiosError) => Promise.reject(this.normalizeError(error)),
    )
  }

  private normalizeError(error: AxiosError): AxiosError {
    const status = error.response?.status
    const data = error.response?.data as Record<string, unknown> | undefined
    const upstreamError = data?.['error']
    const message = (data?.['message'] as string)
      || (typeof upstreamError === 'object' && upstreamError !== null && 'message' in upstreamError
        ? String(upstreamError.message)
        : typeof upstreamError === 'string' ? upstreamError : error.message)
    error.message = message
    error.name = status ? `RelayApiError(${status})` : 'RelayApiError'
    return error
  }

  private normalizeResponse<T>(response: AxiosResponse<RelayCommonResponse<T> | T>): AxiosResponse<T> {
    if (!this.config.openAiVideoModels) {
      response.data = this.unwrapResponse(response.data)
    }
    return response as AxiosResponse<T>
  }

  private unwrapResponse<T>(body: RelayCommonResponse<T> | T): T {
    if (!this.isCommonResponse(body)) {
      return body as T
    }

    if (body.code != null && body.code !== ResponseCode.Success) {
      throw new AppException(body.code, body.message ?? 'Relay API request failed')
    }

    return body.data as T
  }

  private isCommonResponse<T>(body: RelayCommonResponse<T> | T): body is RelayCommonResponse<T> {
    return typeof body === 'object'
      && body !== null
      && 'data' in body
  }

  private stringifyForError(value: unknown): string {
    try {
      return JSON.stringify(value)
    }
    catch {
      return String(value)
    }
  }

  usesMultipartVideoReferences(model: string): boolean {
    return !!this.config.openAiVideoModels && (this.config.multipartVideoReferenceModels?.includes(model) ?? false)
  }

  private buildVideoForm(model: string, request: RelayVideoGenerationRequest, references: RelayVideoReferences): FormData {
    const form = new FormData()
    form.set('model', model)
    form.set('prompt', request.prompt)
    if (request.size)
      form.set('size', request.size)
    if (request.duration !== undefined)
      form.set('seconds', String(request.duration))
    for (const [field, { buffer, mimeType }] of Object.entries(references)) {
      form.set(field, new Blob([new Uint8Array(buffer)], { type: mimeType }), field)
    }
    return form
  }

  /** 提交视频生成任务到上游 relay 服务端 */
  async createVideo(request: RelayVideoGenerationRequest, references?: RelayVideoReferences): Promise<RelayVideoSubmitResponse> {
    return this.aiAvailability.execute(
      { provider: 'relay', operation: 'createVideo', model: request.model },
      async () => {
        const modelMap = this.config.openAiVideoModels
        const upstreamModel = modelMap?.[request.model]?.[request.resolution ?? 'default']
        if (modelMap && !upstreamModel) {
          throw new AppException(ResponseCode.InvalidModel)
        }
        const response: AxiosResponse<RelayVideoSubmitResponse & Pick<OpenAiRelayVideo, 'task_id'>> = upstreamModel
          ? references
            ? await this.httpClient.post('/v1/videos', this.buildVideoForm(upstreamModel, request, references), {
                headers: { 'Content-Type': 'multipart/form-data' },
              })
            : await this.httpClient.post('/v1/videos', { ...request, model: upstreamModel })
          : await this.httpClient.post('/api/ai/video/generations', request)
        const result = response.data
        const id = result?.id || (upstreamModel ? result?.task_id : undefined)
        if (!id) {
          throw new AppException(ResponseCode.AiCallFailed, { error: `Relay video task id is missing: ${this.stringifyForError(result)}` })
        }
        return { ...result, id }
      },
    )
  }

  /**
   * 轮询上游 relay 服务端的视频任务状态
   * 对应上游 GET /ai/video/generations/:taskId
   */
  async getVideo(taskId: string): Promise<RelayVideoCallbackDto> {
    return this.aiAvailability.execute(
      { provider: 'relay', operation: 'getVideo' },
      async () => {
        const response: AxiosResponse<OpenAiRelayVideo> = await this.httpClient.get(
          this.config.openAiVideoModels
            ? `/v1/videos/${encodeURIComponent(taskId)}`
            : `/api/ai/video/generations/${encodeURIComponent(taskId)}`,
        )
        if (!this.config.openAiVideoModels) {
          return response.data
        }
        const { status, videoUrl, coverUrl, error, fail_reason: failureReason } = response.data
        return { id: taskId, status, videoUrl, coverUrl, error: error || failureReason }
      },
    )
  }

  async downloadVideoContent(taskId: string): Promise<Buffer | undefined> {
    if (!this.config.openAiVideoModels) {
      return undefined
    }
    const response = await this.httpClient.get<ArrayBuffer>(`/v1/videos/${encodeURIComponent(taskId)}/content`, {
      responseType: 'arraybuffer',
    })
    return Buffer.from(response.data)
  }
}
