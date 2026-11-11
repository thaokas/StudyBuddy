import { StudyError } from './registry.mjs';

/** Executor IDs survive tool retries; callers can supply a business ID across calls. */
export function toolRequestId(args, exec) {
  const id = args.requestId ?? exec.callId;
  if (typeof id !== 'string' || !id.trim()) throw new StudyError('invalid', '缺少 requestId（或执行器 callId）；请为同一次操作复用稳定 ID');
  return id;
}
