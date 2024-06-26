const express = require('express')
const cors = require('cors')
const moment = require('moment')
const dotenv = require('dotenv')
const DB = require('./db.js')
const User = require('./user.js')
const Exercises = require('./exercises.js')

const app = express()
const root = require('path').join(__dirname, 'build')

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({extended: true}))
app.use(express.static(root))
app.listen(3001, () => {log(1, `Server listening on port ${3001}`);});

dotenv.config();
const DEBUG_LEVEL = process.env.DEBUG_LEVEL
const db = new DB(log)
let exercises = new Exercises(db)

function log(level, message){
    if (process.env.RUN_TESTS == 1 && process.env.DEBUG_WHILE_TEST == 0) return
    if (DEBUG_LEVEL < level) return

    const log_colors = ["\x1b[31m", "\x1b[90m", "\x1b[36m", "\x1b[33m", "\x1b[32m", "\x1b[47m\x1b[30m"]
    process.stdout.write(log_colors.at(level) + "[" + moment().format('YYYY-MM-DD hh:mm:ss') + "]:\x1b[0m ")
    console.log(message)
}


app.get('/api/user', (req, res) => getUserDetails(new User(req, res, db, log)))
app.post('/api/user/muscles', (req, res) => postUserMuscles(new User(req, res, db, log)))
app.post('/api/login', (req, res) => postLogin(new User(req, res, db, log)))
app.post('/api/signup', (req, res) => postUserRegister(new User(req, res, db, log)))

app.post('/api/diet', (req, res) => postDietQuery(new User(req, res, db, log)));
app.post('/api/diet/add', (req, res) => postDietAdd(new User(req, res, db, log)));

app.get('/api/exercises', (req, res) => getExercises(new User(req, res, db, log)))

app.get('/api/templates', (req, res) => getUserTemplates(new User(req, res, db, log)))
app.post('/api/templates/save', (req, res) => postSaveTemplate(new User(req, res, db, log)))
app.post('/api/templates/delete', (req, res) => postDeleteTemplate(new User(req, res, db, log)))

app.get('/api/workouts/finished', (req, res) => getWorkoutsFinished(new User(req, res, db, log)))
app.post('/api/workouts/finish', (req, res) => postFinishWorkout(new User(req, res, db, log)))
app.post('/api/workouts/dates', (req, res) => postWorkoutsDates(new User(req, res, db, log)))
app.post('/api/workouts/data', (req, res) => postUserWorkouts(new User(req, res, db, log)))
app.post('/api/workouts/save', (req, res) => postSaveWorkout(new User(req, res, db, log)))

app.post('/api/reset', (req, res) => postResetPassword(new User(req, res, db, log)));
app.post('/api/reset/generate', (req, res) => postResetGenerate(new User(req, res, db, log)))
app.post('/api/reset/validate', (req, res) => postResetValidate(new User(req, res, db, log)))

app.get('/api/admin/tables', (req, res) => getAdminTables(new User(req, res, db, log)))
app.post('/api/admin/data', (req, res) => postAdminData(new User(req, res, db, log)));
app.post('/api/admin/update', (req, res) => postAdminUpdate(new User(req, res, db, log)));
app.post('/api/admin/delete', (req, res) => postAdminDelete(new User(req, res, db, log)));
app.post('/api/admin/insert', (req, res) => postAdminInsert(new User(req, res, db, log)));

// Leave at the end, otherwise captures all GET requests
app.get("*", (_, res) => {res.sendFile('index.html', { root })})

async function test(){
    if (process.env.RUN_TESTS == 1){
        const debug = process.env.RUN_TESTS_DEBUG == 1 ? true : false
        const Test = require('./test.js')
        const test = new Test("module_test", "module_test@teszt.com", "teszt123", debug)

        await test.runTests()
        await db.query("DELETE FROM user WHERE username='module_test'", [])
    }
}
test()

async function getUserDetails(user){
    log(2, '/api/user')

    const details = await user.userDetails()
    if (!details) return

    user.respondSuccess({username: details.username, email: details.email, isAdmin: details.is_admin})
}

async function getExercises(user){
    log(2, '/api/exercises')

    if (!(await user.isLoggedIn())) return false
    let localExercises = await exercises.exercises

    user.respondSuccess({json: localExercises})
}
async function postLogin(user){
    log(2, '/api/login')

    const token = await user.login()
    if (token === false) return user.respondMissing()
    else if (token === 0) return user.respond(400, {reason: 'Invalid username or password'})

    user.respondSuccess({token: token})
}

async function postUserRegister(user){
    log(2, '/api/signup')

    const token = await user.register()
    if (token === false) return user.respondMissing()
    else if (token === 0) return user.respond(400, {reason: 'Already exists'})

    user.respondSuccess({token: token})
}


async function postWorkoutsDates(user){
    log(2, '/api/workouts/dates')

    let dates = await user.workoutDates()
    if (dates === false) return user.respondMissing()

    user.respondSuccess({dates: dates})
}


async function getWorkoutsFinished(user){
    log(2, '/api/workouts/finished')

    let dates = await user.workoutFinished()
    if (dates === false) return user.respondMissing()

    user.respondSuccess({dates: dates})
}


async function postUserMuscles(user){
    log(2, '/api/user/muscles')

    let userWorkouts = await user.userWorkoutsTimespan()
    if (userWorkouts === false) return user.respondMissing()
    
    let exercisesDone = {}
    let musclesUsed = {}

    userWorkouts.forEach(workout => {
        workout.json.forEach(exercise => {
            let id = exercise.exercise_id
            if (!exercisesDone.hasOwnProperty(id)) exercisesDone[id] = 0
            exercisesDone[id]++
        })
    })

    for (const exerciseId of Object.keys(exercisesDone)){
        let muscles = await exercises.getMuscles(exerciseId)
        muscles.forEach(muscle => {
            if (!musclesUsed.hasOwnProperty(muscle)) musclesUsed[muscle] = 0
            musclesUsed[muscle] += exercisesDone[exerciseId]
        })
    }
    const allMusclesUsed = Object.values(exercisesDone).reduce((acc, x) => acc + x, 0)
    Object.keys(musclesUsed).forEach(muscle => {
        musclesUsed[muscle] = musclesUsed[muscle] / allMusclesUsed
        musclesUsed[muscle] = Math.min(3, Math.max(1, Math.round(musclesUsed[muscle] * 3 + 1)))
    })

    user.respondSuccess({muscles: musclesUsed})
}


async function postDietQuery(user){
    log(2, '/api/diet/')

    let result = await user.diet()
    if (result === false) return user.respondMissing()

    user.respondSuccess({json: result})
}

async function postDietAdd(user){
    log(2, '/api/diet/add')

    let result = await user.dietAdd()
    if (result === false) return user.respondMissing()

    user.respondSuccess()
}

async function postUserWorkouts(user){
    log(2, '/api/workouts/data')

    let result = await user.userWorkoutsMonth()
    if(result === false) return user.respondMissing()

    user.respondSuccess({data: result})
}

async function getUserTemplates(user){
    log(2, '/api/templates')

    let result = await user.userTemplates()
    if(result === false) return user.respondMissing()
    
    for (let workout of result){
        for (let exercise of workout.json){
            exercise.name = await exercises.getName(exercise.exercise_id)
        }
    }
    
    user.respondSuccess({templates: result})
}

async function postSaveWorkout(user){
    log(2, '/api/workouts/save')

    let result = await user.saveWorkout()
    if(result === false) return user.respondMissing()
    
    user.respondSuccess({id: result})
}

async function postFinishWorkout(user){
    log(2, '/api/workouts/finish')

    let result = await user.finishWorkout()
    if(result === false) return user.respondMissing()
    
    user.respondSuccess()
}

async function postSaveTemplate(user){
    log(2, '/api/templates/save')

    let result = await user.saveTemplate()
    if(result === false) return user.respondMissing()
    
    user.respondSuccess()
}

async function postDeleteTemplate(user){
    log(2, '/api/templates/delete')

    let result = await user.deleteTemplate()
    if(result === false) return user.respondMissing()
    
    user.respondSuccess()
}

async function getAdminTables(user){
    log(2, '/api/admin/tables')

    let result = await user.getTables()
    if(result === false) return user.respondMissing()

    user.respondSuccess({tables: result})
}

async function postAdminData(user){
    log(2, '/api/admin/data')

    let result = await user.getTableData()
    if(result === false) return user.respondMissing()

    user.respondSuccess({json: result})
}

async function postAdminUpdate(user){
    log(2, '/api/admin/update')

    let result = await user.updateTableData()
    if(result === false) return user.respondMissing()

    if(result === 1) exercises = new Exercises(db)

    user.respondSuccess()
}

async function postAdminDelete(user){
    log(2, '/api/admin/delete')

    let result = await user.deleteTableData()
    if(result === false) return user.respondMissing()

    if(result === 1) exercises = new Exercises(db)

    user.respondSuccess()
}

async function postAdminInsert(user){
    log(2, '/api/admin/insert')

    let result = await user.insertTableData()
    if(result === false) return user.respondMissing()

    if(result === 0) return user.respond(500, {reason: "SQL error"})
    if(result === 1) exercises = new Exercises(db)

    user.respondSuccess()
}

async function postResetGenerate(user){
    log(2, '/api/reset/generate')

    let result = await user.generateResetToken(process.env.EMAIL_SERVER)
    if (result === false) return user.respondMissing()

    user.respondSuccess()
}

async function postResetValidate(user){
    log(2, '/api/reset/validate')

    let result = await user.validateResetToken()
    if (result === false) return user.respondMissing()

    user.respondSuccess()
}

async function postResetPassword(user){
    log(2, '/api/reset/')

    let result = await user.resetPassword()
    if (result === false) return user.respondMissing()

    user.respondSuccess()
}


