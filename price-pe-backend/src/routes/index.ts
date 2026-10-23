import { Router } from 'express';
import zomatoRoutes from './zomato';
import swiggyRoutes from './swiggy';
import comparisonRoutes from './comparison';
import restaurantRoutes from './restaurants';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'PricePe API v1',
    version: 'v1',
    endpoints: {
      health: 'GET /health',
      root: 'GET /',
      api: 'GET /api/v1',
      products: {
        search: 'GET /api/v1/products/search?q=&location=',
        details: 'GET /api/v1/products/:id',
      },
      restaurants: {
        list: 'GET /api/v1/restaurants?dish=&location=',
        menuComparison: 'GET /api/v1/restaurants/:id/menu-comparison',
      },
      zomato: {
        status: 'GET /api/v1/zomato/status',
        search: 'GET /api/v1/zomato/search?q=&location=',
        menu: 'GET /api/v1/zomato/menu?url=',
      },
      swiggy: {
        status: 'GET /api/v1/swiggy/status',
        search: 'GET /api/v1/swiggy/search?q=&location=',
        menu: 'GET /api/v1/swiggy/menu?url= (via restaurants menu-comparison)',
      },
    },
  });
});

router.use('/zomato', zomatoRoutes);
router.use('/swiggy', swiggyRoutes);
router.use('/products', comparisonRoutes);
router.use('/restaurants', restaurantRoutes);

export default router;
