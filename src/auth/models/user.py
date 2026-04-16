from pydantic import BaseModel
from typing import Optional

class User(BaseModel):
    email: str
    hashed_password: str
    # Add other fields as needed
    
class UserCreate(BaseModel):
    email: str
    password: str

class UserInDB(BaseModel):
    email: str
    hashed_password: str