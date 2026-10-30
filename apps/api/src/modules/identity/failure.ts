export class IdentityFailure extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'IdentityFailure';
  }
}
