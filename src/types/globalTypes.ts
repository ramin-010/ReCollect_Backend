import User,{User as UserType} from '../models/userSchema'

declare global {
  namespace Express {
    interface Request {
      user?: UserType;
    }
  }
}