import type { AiAvailabilityService } from '../../../ai-availability'
import { AppException, ResponseCode } from '@yikart/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayConfig } from './relay.config'
import { RelayLibService } from './relay.service'

vi.mock('../../../ai-availability', () => ({
  AiAvailabilityService: class AiAvailabilityService {},
}))

describe('relayLibService', () => {
  let service: RelayLibService
  let httpClient: {
    post: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    service = new RelayLibService(
      { url: 'https://relay.example.com', apiKey: 'relay-key', timeout: 1000 } as RelayConfig,
      { execute: vi.fn((_context, fn) => fn()) } as unknown as AiAvailabilityService,
    )
    httpClient = {
      post: vi.fn(),
      get: vi.fn(),
    }
    Object.assign(service as unknown as { httpClient: typeof httpClient }, { httpClient })
  })

  function normalizeResponse(data: unknown) {
    return (service as unknown as {
      normalizeResponse: (response: { data: unknown }) => { data: unknown }
    }).normalizeResponse({ data }).data
  }

  it('returns relay video task response when creating relay video tasks', async () => {
    httpClient.post.mockResolvedValue({
      data: { id: 'remote-task-1', status: 'generating' },
    })

    await expect(service.createVideo({
      model: 'relay-video-model',
      prompt: 'video',
    })).resolves.toEqual({ id: 'remote-task-1', status: 'generating' })
  })

  it('unwraps common and legacy data-only responses in response interceptor', () => {
    expect(normalizeResponse({
      code: ResponseCode.Success,
      message: 'ok',
      data: { id: 'remote-task-1', status: 'generating' },
    })).toEqual({ id: 'remote-task-1', status: 'generating' })
    expect(normalizeResponse({
      data: {
        id: 'remote-task-2',
        status: 'generating',
      },
    })).toEqual({ id: 'remote-task-2', status: 'generating' })
  })

  it('returns relay video task status when polling relay video tasks', async () => {
    httpClient.get.mockResolvedValue({
      data: { id: 'remote-task-1', status: 'success', videoUrl: 'videos/out.mp4' },
    })

    await expect(service.getVideo('remote-task-1')).resolves.toEqual({
      id: 'remote-task-1',
      status: 'success',
      videoUrl: 'videos/out.mp4',
    })
  })

  it('maps OpenAI video submission, polling and authenticated content paths', async () => {
    service = new RelayLibService(
      {
        url: 'https://relay.example.com',
        apiKey: 'relay-key',
        timeout: 1000,
        openAiVideoModels: { seedance: { '720p': 'seedance2.0-720p-100%' } },
      },
      { execute: vi.fn((_context, fn) => fn()) } as unknown as AiAvailabilityService,
    )
    expect(Reflect.get(service, 'httpClient').defaults.headers.Authorization).toBe('Bearer relay-key')
    const failedVideo = {
      status: 'failed',
      fail_reason: 'Upstream task failed',
      data: { status: 'in_progress' },
    }
    expect(normalizeResponse(failedVideo)).toEqual(failedVideo)
    Object.assign(service, { httpClient })
    httpClient.post.mockResolvedValue({ data: { task_id: 'remote-id', status: 'queued' } })
    httpClient.get.mockResolvedValueOnce({ data: { status: 'completed' } })
    httpClient.get.mockResolvedValueOnce({ data: Buffer.from('video') })

    await expect(service.createVideo({ model: 'seedance', prompt: 'test', resolution: '720p' }))
      .resolves.toMatchObject({ id: 'remote-id', status: 'queued' })
    expect(httpClient.post).toHaveBeenCalledWith('/v1/videos', {
      model: 'seedance2.0-720p-100%',
      prompt: 'test',
      resolution: '720p',
    })
    await expect(service.getVideo('remote-id')).resolves.toEqual({ id: 'remote-id', status: 'completed' })
    expect(httpClient.get).toHaveBeenCalledWith('/v1/videos/remote-id')
    await expect(service.downloadVideoContent('remote-id')).resolves.toEqual(Buffer.from('video'))
    expect(httpClient.get).toHaveBeenCalledWith('/v1/videos/remote-id/content', { responseType: 'arraybuffer' })
    httpClient.get.mockResolvedValueOnce({ data: failedVideo })
    await expect(service.getVideo('remote-id')).resolves.toMatchObject({
      id: 'remote-id',
      status: 'failed',
      error: 'Upstream task failed',
    })
  })

  it('uploads reference files with the mapped video model and duration', async () => {
    service = new RelayLibService(
      {
        url: 'https://relay.example.com',
        apiKey: 'relay-key',
        timeout: 1000,
        openAiVideoModels: { 'fasth3-omni': { '480p': 'fasth3-omni' } },
        multipartVideoReferenceModels: ['fasth3-omni'],
      },
      { execute: vi.fn((_context, fn) => fn()) } as unknown as AiAvailabilityService,
    )
    Object.assign(service, { httpClient })
    httpClient.post.mockResolvedValue({ data: { id: 'remote-id', status: 'queued' } })
    const buffer = Buffer.from('reference')
    await expect(service.createVideo(
      { model: 'fasth3-omni', prompt: 'Animate the reference', duration: 5, resolution: '480p' },
      { image: { buffer, mimeType: 'image/png' } },
    )).resolves.toMatchObject({ id: 'remote-id' })

    const [url, form] = httpClient.post.mock.calls[0] as [string, FormData]
    expect(url).toBe('/v1/videos')
    expect(form.get('model')).toBe('fasth3-omni')
    expect(form.get('seconds')).toBe('5')
    const image = form.get('image') as File
    expect(image.type).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(buffer)
  })

  it('throws AppException with original response code when common response code is not success', () => {
    expect(() => normalizeResponse({
      code: ResponseCode.InvalidModel,
      message: 'upstream rejected image url',
      data: null,
    })).toThrow(AppException)

    try {
      normalizeResponse({
        code: ResponseCode.InvalidModel,
        message: 'upstream rejected image url',
        data: null,
      })
    }
    catch (error) {
      expect(error).toBeInstanceOf(AppException)
      expect((error as AppException).code).toBe(ResponseCode.InvalidModel)
    }
  })

  it('throws AiCallFailed when relay video submit response has no id', async () => {
    httpClient.post.mockResolvedValue({
      data: { status: 'failed', error: 'invalid image url' },
    })

    await expect(service.createVideo({
      model: 'relay-video-model',
      prompt: 'video',
    })).rejects.toMatchObject({ code: ResponseCode.AiCallFailed })
  })
})
