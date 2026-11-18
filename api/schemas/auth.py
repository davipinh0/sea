"""Auth request schemas."""

from typing import Optional

from pydantic import BaseModel, Field, field_validator


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=150)
    password: str = Field(..., min_length=1, max_length=256)
    # SEA: the app sends the push token of the phone; a registered phone
    # of the user does not need to confirm its own login (mig 092).
    device_token: Optional[str] = Field(None, max_length=200)

    @field_validator("username")
    @classmethod
    def strip_username(cls, v: str) -> str:
        return v.strip()


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=1, max_length=256)


class LoginApprovalPollRequest(BaseModel):
    """SEA: whoever started a login that must be confirmed on the phone."""

    challenge_id: str = Field(..., min_length=1, max_length=64)
    poll_token: str = Field(..., min_length=1, max_length=128)
