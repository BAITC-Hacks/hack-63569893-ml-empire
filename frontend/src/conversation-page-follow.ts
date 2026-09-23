type ConversationBounds = { top: number; bottom: number };
type ConversationTurn = { id: string };

/** Keeps page-level follow opt-in while the reader stays near the conversation end. */
export class ConversationPageFollow {
  private turns: readonly ConversationTurn[] | null = null;
  private visible = false;
  private nearBottom = false;
  private submittedFirstTurn = false;

  followSubmittedTurn() {
    this.submittedFirstTurn = this.visible && this.nearBottom && this.turns?.length === 0;
  }

  observe(bounds: ConversationBounds | null, viewportHeight: number) {
    this.visible = bounds !== null;
    this.nearBottom = bounds !== null
      && bounds.top < viewportHeight
      && bounds.bottom > 0
      && bounds.bottom <= viewportHeight + 80;
  }

  update(turns: readonly ConversationTurn[], bounds: ConversationBounds | null, viewportHeight: number): number {
    const continuesHistory = this.turns !== null
      && turns !== this.turns
      && (this.submittedFirstTurn && turns.length === 1
        || this.turns.length > 0 && turns.length >= this.turns.length && turns[0]?.id === this.turns[0]?.id);
    const offset = continuesHistory && this.visible && this.nearBottom && bounds !== null && bounds.bottom > viewportHeight
      ? bounds.bottom - viewportHeight + 16
      : 0;

    this.turns = turns;
    this.submittedFirstTurn = false;
    this.observe(bounds, viewportHeight);
    // Preserve follow between a synchronous scroll and the next browser scroll event.
    if (offset > 0) this.nearBottom = true;
    return offset;
  }
}
