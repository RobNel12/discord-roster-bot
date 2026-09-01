const MAX_SQUAD_NAME_LENGTH = 50;

export interface ValidSquadName {
  name: string;
  normalizedName: string;
}

export class SquadNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquadNameError";
  }
}

export function validateSquadName(input: string): ValidSquadName {
  const name = input.trim().replace(/\s+/gu, " ");

  if (name.length === 0) {
    throw new SquadNameError("Squad names cannot be empty.");
  }

  if (name.length > MAX_SQUAD_NAME_LENGTH) {
    throw new SquadNameError(
      `Squad names must be ${MAX_SQUAD_NAME_LENGTH} characters or fewer.`,
    );
  }

  if (/\p{C}/u.test(name)) {
    throw new SquadNameError("Squad names cannot contain control characters.");
  }

  return {
    name,
    normalizedName: name.normalize("NFKC").toLocaleLowerCase("en-US"),
  };
}
