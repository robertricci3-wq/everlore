export type ProviderFailureKind =
  | "authentication"
  | "permission"
  | "model"
  | "quota"
  | "rate_limit"
  | "request"
  | "schema"
  | "server"
  | "connection";
export interface ProviderFailure {
  kind: ProviderFailureKind;
  httpStatus: number | null;
  retrySafe: boolean;
}
export function providerFailureMessage(failure: ProviderFailure) {
  const messages: Record<ProviderFailureKind, string> = {
    authentication:
      "OpenAI rejected the API key. Replace it in Connection and allowance settings, then resume your saved story.",
    permission:
      "OpenAI denied this key permission for the request. Check the key’s project permissions, then resume your saved story.",
    model:
      "This OpenAI project cannot access the requested model. Check model access before resuming.",
    quota:
      "OpenAI reports that this project has no available API quota. Check its API billing and limits before resuming. Your Everlore allowance does not add OpenAI credit.",
    rate_limit:
      "OpenAI temporarily rate-limited the request. Wait before resuming your saved story.",
    request:
      "OpenAI rejected the request format. The saved stage needs a technical correction before resuming.",
    schema:
      "OpenAI rejected the story’s structured-output format. The saved stage needs a technical correction before resuming.",
    server:
      "OpenAI could not complete the request. Its completion and charge are uncertain; inspect the saved attempt before retrying.",
    connection:
      "The connection to OpenAI failed before a result was saved. Completion and charges are uncertain; inspect the saved attempt before retrying.",
  };
  return messages[failure.kind];
}
