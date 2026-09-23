import type { ChatPermissions } from 'grammy/types'

/**
 * 权限集合常量。
 *
 * Telegram 的 `restrictChatMember` 语义是「把权限设置成给定集合」，未列出的字段按 `false` 处理，
 * 所以解禁必须显式把每一项都设回 `true`：只传 `can_send_messages: true` 会把成员其他权限一并关掉，
 * 那是比禁言更严重的副作用。因此这里维护两个完整集合，而不是在调用点零散拼字段。
 */

/** 禁言：全部关闭。`until_date` 由调用方给出，到期后 Telegram 自动解禁。 */
export const MUTE_ALL_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
}

/**
 * 解禁：恢复发言相关权限。
 *
 * 刻意不授予 `can_change_info` 与 `can_pin_messages`：这两项属于管理员职权，
 * 普通成员的正常状态里就没有它们，解禁时也不应该凭空给出。
 */
export const GRANT_ALL_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
}
