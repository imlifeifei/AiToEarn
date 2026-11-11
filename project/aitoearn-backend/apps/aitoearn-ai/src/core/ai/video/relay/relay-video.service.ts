import type { RelayVideoCallbackDto, RelayVideoGenerationRequest, RelayVideoReferences, RelayVideoSubmitResponse } from '../../libs/relay/relay.interface'
import type { RelayVideoAiLog } from '../video-ai-log.interface'
import type { UserVideoGenerationRequestDto } from '../video.dto'
import type { VideoTaskInput } from '../video.vo'
import { BadRequestException, Injectable, Optional } from '@nestjs/common'
import { AssetsService, StorageProvider } from '@yikart/assets'
import { AppException, FileUtil, ResponseCode, UserType } from '@yikart/common'
import { AiLogChannel, AiLogRepository, AiLogStatus, AiLogType, AssetStatus, AssetType } from '@yikart/mongodb'
import { TaskStatus } from '../../../../common'
import { AiAvailabilityService } from '../../../ai-availability/ai-availability.service'
import { RelayLibService } from '../../libs/relay'
import { ModelsConfigService } from '../../models-config'
import { RelayMediaResolverService } from '../../relay-media'

@Injectable()
export class RelayVideoService {
  constructor(
    private readonly relayLibService: RelayLibService,
    private readonly aiLogRepo: AiLogRepository,
    private readonly modelsConfigService: ModelsConfigService,
    private readonly aiAvailability: AiAvailabilityService,
    private readonly assetsService: AssetsService,
    private readonly storageProvider: StorageProvider,
    @Optional() private readonly relayMediaResolver?: RelayMediaResolverService,
  ) {}

  private async resolveRelayJson<T>(value: T): Promise<T> {
    if (!this.relayMediaResolver) {
      return value
    }
    return await this.relayMediaResolver.resolveJson(value)
  }

  private async readVideoReferences(request: UserVideoGenerationRequestDto): Promise<RelayVideoReferences> {
    const images = Array.isArray(request.image) ? [...request.image] : request.image ? [request.image] : []
    images.push(...(request.images ?? []))
    const videos = request.video_url ? [request.video_url, ...(request.videos ?? [])] : request.videos ?? []
    const audios = request.audios ?? []
    if (!images.length && !videos.length)
      throw new BadRequestException('请上传一张参考图片或一个参考视频')
    if (images.length > 1 || videos.length > 1 || audios.length > 1 || request.image_tail)
      throw new BadRequestException('最多支持一张参考图片、一个参考视频和一段参考音频')

    const references: RelayVideoReferences = {}
    const fields = { image: images[0], video: videos[0], audio: audios[0] }
    const maxTotalBytes = 48 * 1024 * 1024
    let totalBytes = 0
    for (const field of ['image', 'video', 'audio'] as const) {
      const url = fields[field]
      if (!url)
        continue

      const path = this.assetsService.parsePathFromUrl(url)
      const asset = await this.assetsService.getByPath(path)
      if (!asset || asset.userId !== request.userId || asset.userType !== request.userType || asset.status !== AssetStatus.Confirmed)
        throw new AppException(ResponseCode.AssetNotFound)
      if (!asset.mimeType.startsWith(`${field}/`))
        throw new BadRequestException('参考文件的类型与所选输入不符')
      if (asset.size !== undefined && totalBytes + asset.size > maxTotalBytes)
        throw new AppException(ResponseCode.AssetTooLarge)

      const { buffer } = await this.storageProvider.getObject(path)
      if (!buffer?.length)
        throw new AppException(ResponseCode.AssetNotFound)
      totalBytes += buffer.length
      if (totalBytes > maxTotalBytes)
        throw new AppException(ResponseCode.AssetTooLarge)
      references[field] = { buffer, mimeType: asset.mimeType }
    }
    return references
  }

  async createFromRequest(request: UserVideoGenerationRequestDto): Promise<{ id: string }> {
    const modelConfig = this.modelsConfigService.config.video.generation.find(m => m.name === request.model)
    if (!modelConfig) {
      throw new AppException(ResponseCode.InvalidModel)
    }
    if (request.mode && !(modelConfig.modes as readonly string[]).includes(request.mode)) {
      throw new AppException(ResponseCode.InvalidModel)
    }
    const startedAt = new Date()

    const payload = { ...request } as RelayVideoGenerationRequest & { userId?: string, userType?: UserType, groupId?: string }
    delete payload.userId
    delete payload.userType
    delete payload.groupId

    const references = this.relayLibService.usesMultipartVideoReferences(request.model)
      ? await this.readVideoReferences(request)
      : undefined
    const relayPayload = references
      ? payload
      : await this.resolveRelayJson(payload)

    const result = await this.aiAvailability.executeAsync<RelayVideoSubmitResponse>(
      { provider: 'relay', operation: 'videoGeneration', model: request.model },
      () => references
        ? this.relayLibService.createVideo(relayPayload, references)
        : this.relayLibService.createVideo(relayPayload),
      response => response.id || '',
    )

    const remoteTaskId = result.id
    if (!remoteTaskId) {
      throw new AppException(ResponseCode.AiCallFailed, { error: 'Relay task id is missing' })
    }

    const logRequest: RelayVideoAiLog['request'] = {
      ...payload,
      remoteTaskId,
    }
    if (request.groupId) {
      logRequest.groupId = request.groupId
    }

    const aiLog = await this.aiLogRepo.create({
      userId: request.userId,
      userType: request.userType,
      taskId: remoteTaskId,
      model: request.model,
      channel: AiLogChannel.Relay,
      startedAt,
      type: AiLogType.Video,
      request: logRequest,
      response: {
        ...result,
      },
      status: AiLogStatus.Generating,
    })

    return { id: aiLog.id }
  }

  extractInput(request: RelayVideoAiLog['request']): VideoTaskInput {
    return {
      prompt: request.prompt || '',
      groupId: request.groupId,
      image: request.image,
      images: request.images,
      videoUrl: request.video_url,
      videos: request.videos,
      audios: request.audios,
      duration: request.duration,
      resolution: request.resolution,
      aspectRatio: request.ratio || (request.metadata?.['aspectRatio'] as string | undefined),
      watermark: request.watermark,
    }
  }

  getTaskResult(result: RelayVideoCallbackDto) {
    const status = this.normalizeStatus(result.status)
    const errorMessage = typeof result.error === 'string'
      ? result.error
      : result.error?.message

    return {
      status,
      videoUrl: result.videoUrl ? FileUtil.buildUrl(result.videoUrl) : undefined,
      coverUrl: result.coverUrl ? FileUtil.buildUrl(result.coverUrl) : undefined,
      error: errorMessage ? { message: errorMessage } : undefined,
    }
  }

  private normalizeStatus(status: string | undefined): TaskStatus {
    if (!status) {
      return TaskStatus.InProgress
    }
    const normalized = status.toLowerCase()
    if (['success', 'succeeded', 'completed', 'succeed'].includes(normalized)) {
      return TaskStatus.Success
    }
    if (['failed', 'error', 'failure', 'cancelled', 'canceled'].includes(normalized)) {
      return TaskStatus.Failure
    }
    return TaskStatus.InProgress
  }

  async callback(result: RelayVideoCallbackDto): Promise<RelayVideoCallbackDto> {
    const taskId = result.id
    if (!taskId) {
      throw new AppException(ResponseCode.InvalidAiTaskId)
    }
    const aiLog = await this.aiLogRepo.getByTaskId(taskId)
    if (!aiLog || aiLog.channel !== AiLogChannel.Relay) {
      throw new AppException(ResponseCode.InvalidAiTaskId)
    }
    const relayAiLog = aiLog as RelayVideoAiLog

    if (relayAiLog.status !== AiLogStatus.Generating) {
      return relayAiLog.response!
    }

    const status = this.normalizeStatus(result.status)
    if (status === TaskStatus.InProgress) {
      return { ...result, id: taskId }
    }

    const elapsedMs = Date.now() - relayAiLog.startedAt.getTime()

    let videoUrl = result.videoUrl
    if (status === TaskStatus.Success && !videoUrl) {
      const video = await this.relayLibService.downloadVideoContent(taskId)
      if (video) {
        const upload = await this.assetsService.uploadFromBuffer(relayAiLog.userId, video, {
          type: AssetType.AiVideo,
          mimeType: 'video/mp4',
        }, relayAiLog.model, relayAiLog.userType)
        videoUrl = upload.asset.path
      }
    }

    if (status === TaskStatus.Success && videoUrl) {
      const callbackData: RelayVideoCallbackDto = {
        ...result,
        id: taskId,
        status: 'success',
        videoUrl,
      }

      const updatedAiLog = await this.aiLogRepo.updateByIdAndStatus(
        relayAiLog.id,
        AiLogStatus.Generating,
        {
          $set: {
            status: AiLogStatus.Success,
            response: callbackData,
            duration: elapsedMs,
          },
        },
      )

      if (!updatedAiLog) {
        return relayAiLog.response!
      }

      await this.aiAvailability.recordAsyncComplete(
        taskId,
        { provider: 'relay', operation: 'videoGeneration', model: relayAiLog.model },
        { success: true, latencyMs: elapsedMs },
      )

      return callbackData
    }

    const errorMessage = (typeof result.error === 'string' ? result.error : result.error?.message)
      || (status === TaskStatus.Success ? 'Relay task completed but no video URL returned' : `Relay task ${result.status}`)
    return this.failTask(relayAiLog, taskId, { ...result, id: taskId }, errorMessage, elapsedMs)
  }

  private async failTask(aiLog: RelayVideoAiLog, taskId: string, callbackData: RelayVideoCallbackDto, errorMessage: string, elapsedMs: number): Promise<RelayVideoCallbackDto> {
    const updatedAiLog = await this.aiLogRepo.updateByIdAndStatus(
      aiLog.id,
      AiLogStatus.Generating,
      {
        $set: {
          status: AiLogStatus.Failed,
          response: callbackData,
          duration: elapsedMs,
          errorMessage,
        },
      },
    )

    if (!updatedAiLog) {
      return aiLog.response!
    }

    await this.aiAvailability.recordAsyncComplete(
      taskId,
      { provider: 'relay', operation: 'videoGeneration', model: aiLog.model },
      { success: false, latencyMs: elapsedMs, errorMessage },
    )

    return callbackData
  }
}
