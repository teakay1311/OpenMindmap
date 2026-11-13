/* ============================================================
 * OpenMindmap — lib/scene/icons.ts
 * Bộ icon vector nội bộ (SRS 06.3: 20–50 icon local, không mạng)
 * Path 24×24 theo phong cách outline (stroke 2)
 * ============================================================ */
export interface NodeIcon { id: string; name: string; path: string }

export const NODE_ICONS: NodeIcon[] = [
  { id: 'star', name: 'ngôi sao star', path: 'M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 16.9 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z' },
  { id: 'heart', name: 'trái tim heart', path: 'M12 21C7 16.5 3 13 3 8.8 3 6 5.2 4 7.8 4c1.7 0 3.2.9 4.2 2.3C13 4.9 14.5 4 16.2 4 18.8 4 21 6 21 8.8c0 4.2-4 7.7-9 12.2z' },
  { id: 'flag', name: 'cờ flag', path: 'M5 21V4m0 1h12l-2.5 4L17 13H5' },
  { id: 'fire', name: 'lửa fire', path: 'M12 22c4 0 7-2.8 7-7 0-3-2-5.5-3.5-7C15 10 14 11 12.5 11 13.5 8 13 5 11 3c0 3-1.5 4.5-3 6.5C6.5 11.5 5 13.4 5 15c0 4.2 3 7 7 7z' },
  { id: 'lightbulb', name: 'bóng đèn ý tưởng lightbulb idea', path: 'M9 18h6m-5 3h4M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z' },
  { id: 'check', name: 'dấu check done', path: 'M4 12.5l5 5L20 6.5' },
  { id: 'warning', name: 'cảnh báo warning', path: 'M12 3L2 20h20L12 3zm0 7v5m0 3h.01' },
  { id: 'question', name: 'câu hỏi question', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-2-12a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.8m0 3h.01' },
  { id: 'calendar', name: 'lịch calendar date', path: 'M4 6h16v15H4V6zm0 5h16M8 3v4m8-4v4' },
  { id: 'clock', name: 'đồng hồ clock time', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3.5 2' },
  { id: 'user', name: 'người user person', path: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 10a8 8 0 0 1 16 0' },
  { id: 'users', name: 'nhóm users team', path: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7 .5a3 3 0 1 0 0-6M2 20a7 7 0 0 1 14 0m2.5-6.5A6 6 0 0 1 22 20' },
  { id: 'target', name: 'mục tiêu target goal', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z' },
  { id: 'rocket', name: 'tên lửa rocket', path: 'M5 15c-1 3-1 4-1 4s1 0 4-1m2-7a7 7 0 0 1 10-6 7 7 0 0 1-6 10l-3 3-4-4 3-3zm-3 6l-2-2' },
  { id: 'money', name: 'tiền money cost', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-2-12.5c.5-1 4.5-1.5 4.5.5s-4.5 1.5-4.5 3.5 4 1.5 4.5.5M12 6.5V8m0 8v1.5' },
  { id: 'chart', name: 'biểu đồ chart', path: 'M4 20h16M6 16v-5m4 5V8m4 8v-3m4 3V5' },
  { id: 'book', name: 'sách book', path: 'M5 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5V4zm14 0h-6' },
  { id: 'link', name: 'liên kết link url', path: 'M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1m-1 8a5 5 0 0 1-7 0 5 5 0 0 1 0-7l2-2a5 5 0 0 1 7 0' },
  { id: 'mail', name: 'thư email mail', path: 'M3 6h18v12H3V6zm0 1l9 7 9-7' },
  { id: 'phone', name: 'điện thoại phone', path: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z' },
  { id: 'home', name: 'nhà home', path: 'M4 11l8-7 8 7m-14-1v10h12V10m-8 10v-6h4v6' },
  { id: 'car', name: 'xe car', path: 'M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16m-14 0h14v4h-2m-10 0H5v-4zm2 4a1.5 1.5 0 1 0 3 0m4 0a1.5 1.5 0 1 0 3 0' },
  { id: 'plane', name: 'máy bay plane travel', path: 'M10.5 13.5L3 11l1.5-2 6 1 5-6 2.5 1-3 6.5 5 2.5-1 2-6-1-2.5 4.5-2-.5 2-5.5z' },
  { id: 'music', name: 'nhạc music', path: 'M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm0 0V5l12-2v12m0 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z' },
  { id: 'camera', name: 'máy ảnh camera photo', path: 'M4 8h3l2-3h6l2 3h3v12H4V8zm8 9.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' },
  { id: 'smile', name: 'cười smile', path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 10h.01M15 10h.01M8 14.5s1.5 2 4 2 4-2 4-2' },
  { id: 'cloud', name: 'mây cloud', path: 'M7 18a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-1 7H7z' },
  { id: 'pin', name: 'ghim pin location', path: 'M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z' },
  { id: 'bug', name: 'lỗi bug', path: 'M12 20a6 6 0 0 0 6-6v-3a6 6 0 1 0-12 0v3a6 6 0 0 0 6 6zM9 5l1.5 2M15 5l-1.5 2M4 13h2m12 0h2M5 18l2-1.5M19 18l-2-1.5' },
  { id: 'gift', name: 'quà gift', path: 'M4 11h16v10H4V11zm-1-4h18v4H3V7zm10 0v14M12 7c-2 0-4-1-4-2.5S10 2 12 7zm0 0c2 0 4-1 4-2.5S14 2 12 7z' },
  { id: 'key', name: 'khóa key', path: 'M14 10a4 4 0 1 0-4 4c.6 0 1.2-.1 1.7-.4L13 15h2v2h2v2h3v-3l-6.4-6.4c.3-.5.4-1.1.4-1.6z' },
]
