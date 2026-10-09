/**
 * Whether a keydown belongs to an input method (Japanese, Chinese…) rather
 * than the user, so Enter confirms the characters instead of sending.
 *
 * `isComposing` alone is not enough: WebKit — Safari, and the Outrunner Mac
 * app's webview — ends the composition before the keydown of the Enter that
 * commits it, which then arrives with `isComposing` false and `keyCode` 229.
 */
export function isImeKeydown(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229;
}
