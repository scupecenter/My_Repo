-- Q522 follow-up: the Arabic name of SITE 360 is «الموقع 360».
UPDATE template_definitions SET name_ar = replace(name_ar, 'SITE 360: ', 'الموقع 360: ')
 WHERE template_id IN ('TPL-SITE-DA','TPL-SITE-CW','TPL-SITE-TE','TPL-SITE-CL');
