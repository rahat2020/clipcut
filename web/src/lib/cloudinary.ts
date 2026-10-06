import "server-only";

import type { CloudinaryConfig } from "./uploads/cloudinary-core";
import { env } from "./env";

/** Cloudinary settings from the validated env. The secret never leaves the server. */
export const cloudinaryConfig: CloudinaryConfig = {
  cloudName: env.CLOUDINARY_CLOUD_NAME,
  apiKey: env.CLOUDINARY_API_KEY,
  apiSecret: env.CLOUDINARY_API_SECRET,
  baseFolder: env.CLOUDINARY_FOLDER,
};
