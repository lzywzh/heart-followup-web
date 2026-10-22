export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export const unavailable = (message: string) => new AppError(503, 'SERVICE_UNAVAILABLE', message);
export const notFound = () => new AppError(404, 'NOT_FOUND', '记录不存在或无权访问');
export const conflict = (message = '资料已发生变化，请刷新后重试') => new AppError(409, 'CONFLICT', message);
