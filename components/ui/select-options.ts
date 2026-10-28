/** For a native select: gives its options a solid background and text of
 *  their own. Chrome draws the open list in the select's background, and a
 *  see-through one comes out near white, so light text on it can't be read. */
export const SELECT_OPTIONS = "[&_option]:bg-popover [&_option]:text-popover-foreground";
