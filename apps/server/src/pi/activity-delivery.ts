/** Public session subscriptions are synchronous. Await host projection writes
 * at native extension boundaries instead of building an unbounded promise chain
 * across model turns. This is storage backpressure, not a model/run budget.
 * The native transcript remains the source of original messages/tool results. */
export class ActivityDelivery {
  private pending = new Set<Promise<void>>();
  private failure: Error | undefined;
  private peak = 0;

  emit(write: () => unknown): void {
    try {
      const result = write();
      if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return;
      const pending = Promise.resolve(result).then(() => undefined, error => { this.failed(error); })
        .finally(() => { this.pending.delete(pending); });
      this.pending.add(pending);
      this.peak = Math.max(this.peak, this.pending.size);
    } catch (error) { this.failed(error); }
  }

  private failed(error: unknown) {
    this.failure ??= new Error(`活动日志写入失败；原始会话保留，停止继续执行：${error instanceof Error ? error.message : String(error)}`,
      {cause:error});
  }

  async drain(): Promise<void> {
    // Concurrent native tool results can arrive during a drain. Wait for them,
    // too, before admitting the next producer boundary; never retain old jobs.
    while (this.pending.size) await Promise.all(this.pending);
    if (this.failure) throw this.failure;
  }

  get diagnostics() { return {pending:this.pending.size, peak_pending:this.peak, failed:!!this.failure}; }
}
