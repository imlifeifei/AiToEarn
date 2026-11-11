import { isChina } from '@/constant'
import http from '@/utils/request'

/**
 * Search Douyin Topics
 * Search topics on Douyin/TikTok platforms.
 */
export async function getDouyinTopicsApi(keyword: string): Promise<string[]> {
  const response = await http.post<unknown>('statistics/channels/douyin/searchTopic', {
    topic: keyword,
    language: isChina ? 'zh-CN' : 'en',
  }, true)

  if (response?.code !== 0 || !Array.isArray(response.data)) {
    return []
  }

  return response.data.filter((topic): topic is string => typeof topic === 'string')
}
