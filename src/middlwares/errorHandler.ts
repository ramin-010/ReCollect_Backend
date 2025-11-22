import ErrorResponse from "../utils/errorResponse";
import { Request, Response, NextFunction } from "express";

const errorHandler = (err : any, req : Request, res : Response, next: NextFunction) =>{
    let error = {...err}
   error.message = err.message;

   
  console.error(err.stack);

  // Mongoose Bad ObjectId
  if (err.name === 'CastError') {
    const message = `Resource not found with id of ${err.value}`;
    error = new ErrorResponse( 404, message);
  }
  // Mongoose Validation Error
  else if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val : any) => val.message);
    error = new ErrorResponse(400,  message.join(", "));
  }
  // Mongoose Duplicate Key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue);
    const message = `Duplicate field value entered: ${field}`;
    error = new ErrorResponse(400, message);
  }

  // Send response
  res.status(error.statusCode || 500).json({
    message: error.message || 'Server Error'
  });
}

export default errorHandler;