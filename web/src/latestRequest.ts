export class LatestRequest {
  private revision = 0;
  begin() { return ++this.revision; }
  current(request: number) { return request === this.revision; }
  cancel(request: number) { if (this.current(request)) this.revision++; }
}
