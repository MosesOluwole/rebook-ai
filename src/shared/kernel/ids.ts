/** Identifier source port. Implementations return UUIDv7 strings (time-ordered, index-friendly). */
export interface IdGenerator {
  newId(): string;
}
