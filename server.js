const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'zenith_chads',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'webm'],
        resource_type: 'auto'
    }
});
const upload = multer({ storage });

// --- SCHEMAS ---

// 1. User Schema (NEW: For Permanent Identity)
const userSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    nickname: { type: String, required: true, unique: true },
    isBanned: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// 2. Post Schema (UPDATED)
const postSchema = new mongoose.Schema({
    content: { type: String, default: '' },
    nickname: { type: String, default: 'Anonymous' }, 
    realNickname: { type: String }, // Admin sees this even if they post Anonymously
    deviceId: { type: String }, 
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', null], default: null },
    likes: { type: Number, default: 0 },
    comments: [{ 
        text: String, 
        nickname: { type: String, default: 'Anonymous' }, 
        realNickname: { type: String },
        createdAt: { type: Date, default: Date.now } 
    }],
    ipAddress: { type: String, required: true },
    isPinned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Post = mongoose.model('Post', postSchema);

// --- ROUTES ---

// Device Registration
app.post('/api/register', async (req, res) => {
    const { deviceId, nickname } = req.body;
    try {
        const taken = await User.findOne({ nickname: { $regex: new RegExp(`^${nickname}$`, 'i') } });
        if (taken && taken.deviceId !== deviceId) {
            return res.status(400).json({ error: 'Nickname already taken by another Chad.' });
        }
        await User.findOneAndUpdate(
            { deviceId },
            { nickname },
            { upsert: true, new: true }
        );
        res.json({ success: true, nickname });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Get Posts
app.get('/api/posts', async (req, res) => {
    try {
        // Sorts pinned posts first, then by newest
        const posts = await Post.find().select('-ipAddress -realNickname').sort({ isPinned: -1, createdAt: -1 });
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Get Trending Posts
app.get('/api/posts/trending', async (req, res) => {
    try {
        const posts = await Post.find().select('-ipAddress -realNickname').sort({ likes: -1, createdAt: -1 }).limit(20);
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Create Post
app.post('/api/posts', upload.single('media'), async (req, res) => {
    try {
        if (!req.body.content && !req.file) return res.status(400).json({ error: 'You must provide text or a file.' });
        
        const user = await User.findOne({ deviceId: req.body.deviceId });
        if (!user && req.body.deviceId) return res.status(403).json({ error: 'Unregistered device.' });
        
        const isAnon = req.body.isAnonymous === 'true';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        const newPost = new Post({
            content: req.body.content,
            nickname: (isAnon || !user) ? 'Anonymous' : user.nickname,
            realNickname: user ? user.nickname : 'Unknown',
            deviceId: req.body.deviceId,
            mediaUrl: req.file ? req.file.path : null,
            mediaType: req.body.mediaType || null,
            ipAddress: userIp
        });
        await newPost.save();
        res.status(201).json({ message: 'Dropped successfully' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Like Post
app.post('/api/posts/:id/like', async (req, res) => {
    try {
        await Post.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to like' }); }
});

// Comment on Post
app.post('/api/posts/:id/comment', async (req, res) => {
    try {
        const user = await User.findOne({ deviceId: req.body.deviceId });
        const isAnon = req.body.isAnonymous === 'true';
        
        await Post.findByIdAndUpdate(req.params.id, { 
            $push: { 
                comments: { 
                    text: req.body.text,
                    nickname: (isAnon || !user) ? 'Anonymous' : user.nickname,
                    realNickname: user ? user.nickname : 'Unknown'
                } 
            } 
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to comment' }); }
});

// --- ADMIN ROUTES ---

app.get('/api/admin/posts', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        const posts = await Post.find().sort({ createdAt: -1 });
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/posts/:id', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        await Post.findByIdAndDelete(req.params.id);
        res.json({ message: 'Post erased.' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/posts/:id/pin', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        const post = await Post.findById(req.params.id);
        post.isPinned = !post.isPinned;
        await post.save();
        res.json({ message: 'Pin toggled.' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/users/rename', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        await User.findOneAndUpdate({ nickname: req.body.oldName }, { nickname: req.body.newName });
        res.json({ message: 'User renamed.' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('Connected to Database.');
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => console.error(err));