/**
 * Whether a conversation keeps following its end after a scroll event.
 *
 * Only the user scrolling up stops it (`byUser`: the scroll came with their
 * wheel, touch, keys or scrollbar), and reaching the end starts it again.
 * Nothing else may stop it: the event for a jump to the end can come after
 * more of a streamed history has landed below, leaving the view far from the
 * new end, and rows rendering above it at their real height can move it up
 * as the browser keeps what's on screen in place. A panel that's hidden
 * (display: none, a session the router keeps for going back to) reads as
 * zero-sized and says nothing about where the user is.
 */
export function followsAfterScroll(input: {
  following: boolean;
  byUser: boolean;
  /** Where the view's top is now, and was at the last scroll event. */
  top: number;
  lastTop: number;
  viewHeight: number;
  scrollHeight: number;
}): boolean {
  if (input.viewHeight === 0) return input.following;
  if (input.scrollHeight - input.top - input.viewHeight < FOLLOW_SLACK_PX) return true;
  if (input.byUser && input.top < input.lastTop) return false;
  return input.following;
}

/** How near the end counts as at it. */
export const FOLLOW_SLACK_PX = 120;

/** How long after the user's wheel, touch, key or pointer a scroll is theirs:
 *  a trackpad's momentum keeps sending wheel events while it coasts. */
export const USER_SCROLL_MS = 500;
