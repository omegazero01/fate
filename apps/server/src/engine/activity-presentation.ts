/** Read-time compatibility only: never rewrite historical activity bodies or
 * infer that a submitted native steering message has been delivered. */
export function activityControlFields(row: Record<string, unknown>) {
  const metadata = row.metadata as Record<string, unknown> | undefined;
  return metadata?.event_type === 'steering' && ['user', 'status'].includes(String(row.kind))
    ? {kind: 'status', tool: 'steer_work'} : {};
}
