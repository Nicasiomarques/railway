import { ApiError } from "./errors.js";

export function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ApiError(400, "invalid_slug", "Não foi possível gerar um slug a partir do nome.");
  return slug;
}
