/** Netatmo OAuth tokens as stored by the local and remote servers (runtime-neutral, ADR-0014). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms. */
  obtainedAt: number;
  scope: string[];
  /** The app that obtained these tokens. Refresh only works with the same app. */
  clientId: string;
}

/** Supplies Netatmo access tokens to the API client. */
export interface TokenProvider {
  /** A currently valid access token, refreshing first if needed. */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Called when the API rejected `rejectedToken` as invalid or expired.
   * Returns a different, fresh token, or throws AuthRequiredError.
   */
  handleRejectedToken(rejectedToken: string, signal?: AbortSignal): Promise<string>;
}
