import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { PreKeyDTO, SignedPreKeyDTO } from '@signalix/contracts';

// Base64url alphabet without padding. Used by all key/signature blobs on
// the wire. The length range is intentionally generous (any X25519
// pub-key encodes to 43 chars; an Ed25519 sig encodes to 86) — we leave
// strict size checks to the crypto layer once it lands in v0.9.0.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class PreKeyMaterialDto implements PreKeyDTO {
  @IsInt()
  @Min(0)
  keyId!: number;

  @IsString()
  @MinLength(20)
  @MaxLength(512)
  @Matches(BASE64URL, { message: 'publicKey must be base64url-encoded' })
  publicKey!: string;

  @IsOptional()
  @IsString()
  algorithm: 'x25519' = 'x25519';
}

export class SignedPreKeyMaterialDto implements SignedPreKeyDTO {
  @IsInt()
  @Min(0)
  keyId!: number;

  @IsString()
  @MinLength(20)
  @MaxLength(512)
  @Matches(BASE64URL, { message: 'publicKey must be base64url-encoded' })
  publicKey!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(512)
  @Matches(BASE64URL, { message: 'signature must be base64url-encoded' })
  signature!: string;

  @IsOptional()
  @IsString()
  algorithm: 'x25519' = 'x25519';
}

export class RegisterDeviceKeysDto {
  @IsInt()
  @Min(0)
  registrationId!: number;

  @IsString()
  @MinLength(20)
  @MaxLength(512)
  @Matches(BASE64URL, { message: 'identityKey must be base64url-encoded' })
  identityKey!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(512)
  @Matches(BASE64URL, { message: 'signingKey must be base64url-encoded' })
  signingKey!: string;

  @ValidateNested()
  @Type(() => SignedPreKeyMaterialDto)
  signedPreKey!: SignedPreKeyMaterialDto;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PreKeyMaterialDto)
  preKeys!: PreKeyMaterialDto[];

  @IsOptional()
  @IsString()
  algorithm: 'x25519' = 'x25519';
}

export class RotateSignedPreKeyDto {
  @ValidateNested()
  @Type(() => SignedPreKeyMaterialDto)
  signedPreKey!: SignedPreKeyMaterialDto;
}

export class UploadPreKeysDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PreKeyMaterialDto)
  preKeys!: PreKeyMaterialDto[];

  @IsOptional()
  @IsString()
  algorithm: 'x25519' = 'x25519';
}
