const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const winston = require('winston');

// ==========================================
// HOCANIN İSTEDİĞİ KURUMSAL LOGLAMA SİSTEMİ (WINSTON)
// ==========================================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'uygulama.log' }),
    new winston.transports.Console()
  ],
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// AIVEN BULUT VERİTABANI BAĞLANTI AYARLARI
// ==========================================
const db = mysql.createConnection({
    host: 'mysql-128e52be-yuksel-otopark.g.aivencloud.com',
    port: 10991,
    user: 'avnadmin',
    password: 'AVNS_QzRXCaq-pbZv8VOlz7W', 
    database: 'defaultdb',
    ssl: {
        rejectUnauthorized: false
    }
});

// Veritabanı Bağlantısı ve Otomatik Tablo Kurulumları
db.connect(err => {
    if (err) {
        logger.error(`Veritabanına bağlanırken kritik hata oluştu: ${err.message}`);
        return;
    }
    logger.info('MySQL Bulut Veritabanına başarıyla bağlanıldı!');

    // 1. Kullanıcılar Tablosunu Oluştur
    const tblKullanicilar = `
    CREATE TABLE IF NOT EXISTS kullanicilar (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kullanici_adi VARCHAR(50) NOT NULL UNIQUE,
        sifre VARCHAR(50) NOT NULL
    );`;

    // 2. Araçlar Tablosunu Oluştur
    const tblAraclar = `
    CREATE TABLE IF NOT EXISTS araclar (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plaka VARCHAR(20) NOT NULL,
        marka VARCHAR(50),
        model VARCHAR(50),
        arac_turu VARCHAR(50) DEFAULT 'Otomobil',
        durum VARCHAR(20) DEFAULT 'İçeride',
        giris_tarihi TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cikis_tarihi TIMESTAMP NULL,
        ucret DECIMAL(10,2) DEFAULT 0.00
    );`;

    db.query(tblKullanicilar, (err) => {
        if (err) logger.error('Kullanıcılar tablosu oluşturulamadı: ' + err.message);
        else {
            db.query("SELECT * FROM kullanicilar WHERE kullanici_adi = 'admin'", (err, rows) => {
                if (!err && rows.length === 0) {
                    db.query("INSERT INTO kullanicilar (kullanici_adi, sifre) VALUES ('admin', '123456')");
                    logger.info('Varsayılan admin kullanıcısı bulut veritabanına eklendi. (Şifre: 123456)');
                }
            });
        }
    });

    db.query(tblAraclar, (err) => {
        if (err) logger.error('Araçlar tablosu oluşturulamadı: ' + err.message);
        else logger.info('Bulut veritabanı tabloları hazır ve güncel!');
    });
});

// ==========================================
//      YÜKSEL OTOPARK SİSTEMİ API'LERİ
// ==========================================

// 1. GİRİŞ YAPMA BAĞLANTISI (Login API)
app.post('/api/login', (req, res) => {
    const { kullanici_adi, sifre } = req.body;
    db.query('SELECT * FROM kullanicilar WHERE kullanici_adi = ? AND sifre = ?', [kullanici_adi, sifre], (err, results) => {
        if (err) {
            logger.error(`Giriş işlemi sırasında veritabanı hatası: ${err.message}`);
            return res.status(500).send(err);
        }
        if (results.length > 0) {
            logger.info(`Sisteme başarılı giriş yapıldı - Kullanıcı: ${kullanici_adi}`);
            res.send({ success: true, message: 'Giriş Başarılı!' });
        } else {
            logger.warn(`Hatalı giriş denemesi - Kullanıcı: ${kullanici_adi}`);
            res.send({ success: false, message: 'Hatalı Kullanıcı Adı veya Şifre!' });
        }
    });
});

// 2. ARAÇ KAYDETME BAĞLANTISI (Türkiye Saat Dilimi Uyumlu)
app.post('/api/araclar/giris', (req, res) => {
    const { plaka, marka, model, arac_turu } = req.body;
    
    if (!plaka) {
        return res.status(400).send({ success: false, message: 'Plaka alanı zorunludur!' });
    }

    const query = "INSERT INTO araclar (plaka, marka, model, arac_turu, giris_tarihi) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 3 HOUR))";
    db.query(query, [plaka, marka, model, arac_turu || 'Otomobil'], (err, result) => {
        if (err) {
            logger.error(`Araç kaydı sırasında veritabanı hatası - Plaka: ${plaka}, Hata: ${err.message}`);
            return res.status(500).send({ success: false, message: 'Veritabanı hatası oluştu!' });
        }
        logger.info(`Yeni araç girişi yapıldı - Plaka: ${plaka}, Marka/Model: ${marka} ${model}, Tür: ${arac_turu || 'Otomobil'}`);
        res.send({ success: true, message: 'Araç başarıyla otoparka giriş yaptı!' });
    });
});

// 3. İÇERİDEKİ ARAÇLARI LİSTELEME BAĞLANTISI (Araç Listesi API)
app.get('/api/araclar/iceridekiler', (req, res) => {
    const query = "SELECT * FROM araclar WHERE durum = 'İçeride' ORDER BY giris_tarihi DESC";
    db.query(query, (err, results) => {
        if (err) {
            logger.error(`İçerideki araçlar listelenirken hata oluştu: ${err.message}`);
            return res.status(500).send({ success: false, message: 'Veritabanı hatası!' });
        }
        res.send({ success: true, data: results });
    });
});

// 4. ARAÇ ÇIKIŞI VE ÜCRET HESAPLAMA BAĞLANTISI (HATA DÜZELTİLDİ)
app.post('/api/araclar/cikis', (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).send({ success: false, message: 'Araç ID bilgisi eksik!' });
    }

    const selectQuery = 'SELECT plaka, giris_tarihi, arac_turu FROM araclar WHERE id = ?';
    db.query(selectQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            logger.error(`Çıkış yapılmak istenen Araç ID'si bulunamadı: ${id}`);
            return res.status(500).send({ success: false, message: 'Araç bulunamadı!' });
        }

        const plaka = results[0].plaka;
        const girisTarihi = new Date(results[0].giris_tarihi);
        const bransAracTuru = results[0].arac_turu || 'Otomobil'; // Değişken ismi düzeltildi
        
        // Çıkış saatini Türkiye saat dilimine eşitlemek için sunucu saatine 3 saat ekliyoruz
        const cikisTarihi = new Date(new Date().getTime() + (3 * 60 * 60 * 1000)); 

        const farkMilisaniye = cikisTarihi - girisTarihi;
        let farkSaat = farkMilisaniye / (1000 * 60 * 60);

        if (farkSaat < 1) farkSaat = 1;

        let saatUcreti = 50; 
        if (bransAracTuru === 'Motosiklet') saatUcreti = 30;
        if (bransAracTuru === 'Kamyon/Otobüs') saatUcreti = 100;

        const toplamUcret = Math.ceil(farkSaat) * saatUcreti;

        const updateQuery = "UPDATE araclar SET cikis_tarihi = DATE_ADD(NOW(), INTERVAL 3 HOUR), ucret = ?, durum = 'Çıktı' WHERE id = ?";
        db.query(updateQuery, [toplamUcret, id], (err2, result2) => {
            if (err2) {
                logger.error(`Araç çıkış kaydı güncellenirken hata - Araç ID: ${id}, Hata: ${err2.message}`);
                return res.status(500).send({ success: false, message: 'Veritabanı güncellenemedi!' });
            }
            
            logger.info(`Araç çıkışı yapıldı - Plaka: ${plaka}, Süre: ${Math.ceil(farkSaat)} saat, Alınan Ücret: ${toplamUcret} TL`);
            
            res.send({ 
                success: true, 
                message: 'Araç çıkışı başarıyla yapıldı!',
                ucret: toplamUcret,
                sure: Math.ceil(farkSaat)
            });
        });
    });
});

// 5. TOPLAM CİRO VE İSTATİSTİK BAĞLANTISI (Dashboard API)
app.get('/api/istatistikler', (req, res) => {
    const query = "SELECT COUNT(*) as cikan_sayisi, SUM(ucret) as toplam_ciro FROM araclar WHERE durum = 'Çıktı'";
    db.query(query, (err, results) => {
        if (err) {
            logger.error(`İstatistik paneli verileri çekilirken hata: ${err.message}`);
            return res.status(500).send({ success: false, message: 'Veritabanı hatası!' });
        }
        res.send({ 
            success: true, 
            cikanSayisi: results[0].cikan_sayisi || 0,
            toplamCiro: results[0].toplam_ciro || 0 
        });
    });
});

// 6. GEÇMİŞTE ÇIKAN ARAÇLARI LİSTELEME BAĞLANTISI (Raporlama API)
app.get('/api/araclar/gecmis', (req, res) => {
    const query = "SELECT * FROM araclar WHERE durum = 'Çıktı' ORDER BY id DESC, cikis_tarihi DESC";
    db.query(query, (err, results) => {
        if (err) {
            logger.error(`Geçmiş araç raporları çekilirken hata: ${err.message}`);
            return res.status(500).send({ success: false, message: 'Veritabanı hatası!' });
        }
        res.send({ success: true, data: results });
    });
});

const PORT = 5000;
app.listen(PORT, () => {
    logger.info(`Yüksel Otopark Otomasyon Sunucusu port ${PORT} üzerinde güvenli modda çalışıyor...`);
});