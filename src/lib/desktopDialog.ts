export function supportsNativeDirectoryPicker() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function pickNativeOutputDirectory() {
  if (!supportsNativeDirectoryPicker()) {
    throw new Error('当前网页调试环境不提供系统目录选择器，请手工输入绝对路径。')
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    title: '选择 AEONQUILL 输出目录',
    directory: true,
    multiple: false,
  })
  if (selected === null) return null
  if (Array.isArray(selected)) return selected[0] ?? null
  return selected
}
