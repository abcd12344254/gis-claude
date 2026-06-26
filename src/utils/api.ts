/** API 基础路径：开发环境为空（走 Vite 代理），生产环境为 Render 后端地址 */
export const API_BASE: string = import.meta.env.VITE_API_BASE_URL || '';
