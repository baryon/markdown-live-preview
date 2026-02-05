# Recharts Test

This is a simple test for recharts rendering.

## Line Chart

```recharts
<LineChart width={500} height={300} data={[
  { name: 'A', value: 100 },
  { name: 'B', value: 200 },
  { name: 'C', value: 150 }
]}>
  <XAxis dataKey="name" />
  <YAxis />
  <Line type="monotone" dataKey="value" stroke="#8884d8" />
</LineChart>
```

## Bar Chart

```recharts
<BarChart width={500} height={300} data={[
  { name: 'X', value: 50 },
  { name: 'Y', value: 80 }
]}>
  <XAxis dataKey="name" />
  <YAxis />
  <Bar dataKey="value" fill="#82ca9d" />
</BarChart>
```

## End

If you see charts above, recharts is working!
