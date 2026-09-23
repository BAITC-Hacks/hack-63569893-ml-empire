/** One explicit gesture may start one recording, after its own connection is ready. */
export class VoiceCallStart {
  private connectingEpoch: number | null = null;
  private voiceEpoch: number | null = null;

  get isStarting() { return this.connectingEpoch !== null || this.voiceEpoch !== null; }

  begin(epoch: number, voice: boolean) {
    if (this.isStarting) return false;
    this.connectingEpoch = epoch;
    this.voiceEpoch = voice ? epoch : null;
    return true;
  }

  ready(epoch: number) {
    if (this.connectingEpoch === epoch) this.connectingEpoch = null;
  }

  takeRecording(epoch: number) {
    if (this.connectingEpoch !== null || this.voiceEpoch !== epoch) return false;
    this.voiceEpoch = null;
    return true;
  }

  cancel() {
    this.connectingEpoch = null;
    this.voiceEpoch = null;
  }
}
