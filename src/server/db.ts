import mongoose from 'mongoose'
import dotenv from 'dotenv'
dotenv.config();

const url = process.env.MONGO_URL;
if(!url){
    throw new Error("Mongo url is missing")
}

 const ConnectDb = async () : Promise<void> =>{
    try{
        const connection = await mongoose.connect(url);
        console.log(`Mongo Connected✅ : ${connection.connection.host}`)
    }catch(err : any){
        console.error('Error Connecting :', err);
        process.exit(1);
    }
}

export default ConnectDb;